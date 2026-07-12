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
    } catch (e) {
      logger.warn(`[SETTLEMENT] Initial error: ${e.message}`)
    }
  }, 180000).unref()
}

module.exports = { startSettlementCycle }
