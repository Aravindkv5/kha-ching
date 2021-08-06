import axios from 'axios'
import console from '../logging'
import { addToNextQueue, EXIT_TRADING_Q_NAME } from '../queue'
import { getTimeLeftInMarketClosingMs, syncGetKiteInstance, getInstrumentPrice, withRemoteRetry, withoutFwdSlash, SIGNALX_AXIOS_DB_AUTH } from '../utils'

import { doSquareOffPositions } from './autoSquareOff'

const DATABASE_HOST_URL = process.env.DATABASE_HOST_URL
const DATABASE_USER_KEY = process.env.DATABASE_USER_KEY

const patchTradeWithTrailingSL = async ({ tag, trailingSL }) => {
  const endpoint = `${withoutFwdSlash(DATABASE_HOST_URL)}/day_${DATABASE_USER_KEY}?q=orderTag:${tag}`
  try {
    const { data: [dbProps] } = await axios(endpoint)
    await axios.put(`${withoutFwdSlash(DATABASE_HOST_URL)}/day_${DATABASE_USER_KEY}/${dbProps._id}`, {
      ...dbProps,
      liveTrailingSL: trailingSL
    }, SIGNALX_AXIOS_DB_AUTH)
  } catch (e) {
    console.log('🔴 [patchTradeWithTrailingSL] error', e)
  }
}

export default async ({ initialJobData, rawKiteOrdersResponse }) => {
  try {
    if (getTimeLeftInMarketClosingMs() < 0) {
      return Promise.resolve(
        '🟢 [multiLegPremiumThreshold] Terminating Combined Premium checker as market closing...'
      )
    }

    const { slmPercent, trailingSlPercent, user, trailEveryPercentageChangeValue, lastTrailingSlTriggerAtPremium } = initialJobData
    const kite = syncGetKiteInstance(user)

    /**
     * Trailing SL method
     * 1. initial total SL = initialPremiumReceived + sl% * initialPremiumReceived
     * 2. trailing SL
     *    on every decrease in combined premium by X%, trail the SL by initial SL %
     *
     * e.g. at 9.20am
     * initial premium = 400 = lastInflectionPoint
     * initial SL = 10%
     * total SL = 440
     *
     *
     * At 10.00am
     * combined premium = 380
     * decrease in premium = 5%
     * new SL = 380 + 10% * 380 = 418
     *  terminate this job, add a replica to same queue
     *  with lastTrailingSlTriggerAtPremium = 380
     *
     *
     * At 10.15am
     * combined premium = 390
     * ideal SL = 400 + 10%*440 = 440
     * trailing SL = 418
     * SL = min(ideal SL, trailing SL)
     * no changes
     */

    const legsOrders = rawKiteOrdersResponse
    // check here if the open positions include these legs
    // and quantities should be greater than equal to `legsOrders`
    // if not, resolve this checker assuming the user has squared off the positions themselves

    const tradingSymbols = legsOrders.map((order) => order.tradingsymbol)

    const averageOrderPrices = legsOrders.map((order) => order.average_price)
    const initialPremiumReceived = averageOrderPrices.reduce((sum, price) => sum + price, 0)

    const liveSymbolPrices = await Promise.all(
      tradingSymbols.map((symbol) => withRemoteRetry(getInstrumentPrice(kite, symbol, kite.EXCHANGE_NFO)))
    )

    const liveTotalPremium = liveSymbolPrices.reduce((sum, price) => sum + price, 0)
    const initialSlTotalPremium = initialPremiumReceived + (slmPercent / 100 * initialPremiumReceived) // 440

    let checkAgainstSl = initialSlTotalPremium

    if (trailEveryPercentageChangeValue) {
      const trailingSlTotalPremium = lastTrailingSlTriggerAtPremium
        ? (lastTrailingSlTriggerAtPremium + ((trailingSlPercent || slmPercent) / 100 * lastTrailingSlTriggerAtPremium))
        : null // 418
      checkAgainstSl = trailingSlTotalPremium || initialSlTotalPremium // 418

      if (liveTotalPremium < checkAgainstSl) {
        const lastInflectionPoint = lastTrailingSlTriggerAtPremium || initialPremiumReceived // 380
        // liveTotalPremium = 360
        const changeFromLastInflectionPoint =
          ((liveTotalPremium - lastInflectionPoint) / lastInflectionPoint) * 100
        // continue the checker
        if (
          changeFromLastInflectionPoint < 0 &&
          Math.abs(changeFromLastInflectionPoint) >= trailEveryPercentageChangeValue
        ) {
          // update lastTrailingSlTriggerAtPremium
          // if current liveTotalPremium is X% lesser than trailEveryPercentageChangeValue

          // add to same queue with updated params
          await addToNextQueue({
            ...initialJobData,
            lastTrailingSlTriggerAtPremium: liveTotalPremium
          }, {
            __nextTradingQueue: EXIT_TRADING_Q_NAME,
            rawKiteOrdersResponse
          })

          // update db trade with new combined SL property
          // and expose it in the UI
          await patchTradeWithTrailingSL({ tag: initialJobData.orderTag, trailingSL: (liveTotalPremium + ((trailingSlPercent || slmPercent) / 100 * liveTotalPremium)) })

          const resolveMsg = `⚡️ [multiLegPremiumThreshold] trailing new inflection point ${liveTotalPremium}`
          console.log(resolveMsg)
          // terminate this worker
          return Promise.resolve(resolveMsg)
        }
      }
    }

    if (liveTotalPremium < checkAgainstSl) {
      const rejectMsg = `🟢 [multiLegPremiumThreshold] liveTotalPremium (${liveTotalPremium}) < threshold (${checkAgainstSl})`
      return Promise.reject(new Error(rejectMsg))
    }

    // terminate the checker
    const exitMsg = `☢️ [multiLegPremiumThreshold] triggered! liveTotalPremium (${liveTotalPremium}) > threshold (${checkAgainstSl})`
    console.log(exitMsg)

    return doSquareOffPositions(legsOrders, kite, initialJobData)
  } catch (e) {
    console.log('☢️ [multiLegPremiumThreshold] terminated', e)
    return Promise.resolve(e)
  }
}
