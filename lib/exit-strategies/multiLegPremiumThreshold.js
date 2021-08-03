import console from '../logging'
import { addToNextQueue, EXIT_TRADING_Q_NAME } from '../queue'
import { getTimeLeftInMarketClosingMs, syncGetKiteInstance, getInstrumentPrice, withRemoteRetry } from '../utils'

import { doSquareOffPositions } from './autoSquareOff'

export default async ({ initialJobData, rawKiteOrdersResponse }) => {
  try {
    if (getTimeLeftInMarketClosingMs() < 0) {
      return Promise.resolve(
        '🟢 [multiLegPremiumThreshold] Terminating Combined Premium checker as market closing...'
      )
    }

    const { slmPercent, trailingSlPercent = 5, user, trailEveryPercentageChangeValue = 2, lastTrailingSlTriggerAtPremium } = initialJobData
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
    const trailingSlTotalPremium = lastTrailingSlTriggerAtPremium ? (lastTrailingSlTriggerAtPremium + (trailingSlPercent / 100 * lastTrailingSlTriggerAtPremium)) : null // 418
    const slTotalPremium = trailingSlTotalPremium || initialSlTotalPremium // 418

    if (liveTotalPremium < slTotalPremium) {
      const lastInflectionPoint = lastTrailingSlTriggerAtPremium || initialPremiumReceived // 380
      // liveTotalPremium = 360
      const changeFromLastInflectionPoint =
        ((liveTotalPremium - lastInflectionPoint) / lastInflectionPoint) * 100
      // continue the checker
      if (changeFromLastInflectionPoint < 0 && Math.abs(changeFromLastInflectionPoint) >= trailEveryPercentageChangeValue) {
        // update lastTrailingSlTriggerAtPremium
        // if current liveTotalPremium is X% lesser than trailEveryPercentageChangeValue

        // terminate this job, and add to same queue with updated params
        await addToNextQueue({
          ...initialJobData,
          lastTrailingSlTriggerAtPremium: liveTotalPremium
        }, {
          __nextTradingQueue: EXIT_TRADING_Q_NAME,
          rawKiteOrdersResponse
        })

        const resolveMsg = `⚡️ [multiLegPremiumThreshold] trailing new inflection point ${liveTotalPremium}`
        console.log(resolveMsg)
        return Promise.resolve(resolveMsg)
      }

      const rejectMsg = `🟢 [multiLegPremiumThreshold] liveTotalPremium (${liveTotalPremium}) < threshold (${slTotalPremium})`
      return Promise.reject(new Error(rejectMsg))
    }

    // terminate the checker
    const exitMsg = `☢️ [multiLegPremiumThreshold] triggered! liveTotalPremium (${liveTotalPremium}) > threshold (${slTotalPremium})`
    console.log(exitMsg)

    return doSquareOffPositions(legsOrders, kite, initialJobData)
  } catch (e) {
    console.log('☢️ [multiLegPremiumThreshold] terminated', e)
    return Promise.resolve(e)
  }
}
