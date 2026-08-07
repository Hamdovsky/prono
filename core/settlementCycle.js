const logger = require('./logger')
const memoryManager = require('./memoryManager')

function startSettlementCycle(intervalMs = 15 * 60 * 1000) {
  const settlementService = require('../services/settlementService')

  setInterval(async () => {
    logger.info('[SETTLEMENT] Cycle start...')
    try {
      const result = await settlementService.settleFinishedMatches()
      if (result.settled > 0) {
        logger.info(`[SETTLEMENT] ${result.settled}/${result.total} settled`)
      }
      // Link pending top-picks to finished matches and settle them
      try {
        const topPicks = require('../services/topPicksService')
        const link = topPicks.linkPicksToMatches()
        const settle = topPicks.settlePendingPicks()
        if (link.linked > 0 || settle.settled > 0) {
          logger.info(`[SETTLEMENT] Top-picks: ${link.linked} linked, ${settle.settled} settled`)
        }
      } catch (e) {
        logger.warn(`[SETTLEMENT] Top-picks scoring error: ${e.message}`)
      }
    } catch (e) {
      logger.warn(`[SETTLEMENT] Error: ${e.message}`)
    }
  }, intervalMs).unref()

  setTimeout(async () => {
    logger.info('[SETTLEMENT] Initial missing-score fetch (startup)...')
    try {
      const result = await settlementService.fetchMissingScores()
      if (result.fetched > 0) {
        logger.info(`[SETTLEMENT] ${result.fetched} missing scores fetched`)
      }
      memoryManager.maybeGC()
      const settleResult = await settlementService.settleFinishedMatches()
      logger.info(`[SETTLEMENT] Initial: ${settleResult.settled}/${settleResult.total} settled`)
      try {
        const topPicks = require('../services/topPicksService')
        const link = topPicks.linkPicksToMatches()
        const settle = topPicks.settlePendingPicks()
        logger.info(`[SETTLEMENT] Initial top-picks: ${link.linked} linked, ${settle.settled} settled`)
      } catch (e) {
        logger.warn(`[SETTLEMENT] Initial top-picks error: ${e.message}`)
      }
    } catch (e) {
      logger.warn(`[SETTLEMENT] Initial error: ${e.message}`)
    }
  }, 180000).unref()
}

module.exports = { startSettlementCycle }
