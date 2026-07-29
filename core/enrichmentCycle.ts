// @ts-nocheck
import logger from './logger'
import database from './database'
import memoryManager from './memoryManager'

let isEnricherRunning = false

async function runEnrichmentCycle(services) {
  if (isEnricherRunning) {
    logger.warn('[ENRICHER] Previous cycle still running — skipping')
    return
  }

  isEnricherRunning = true
  logger.info('[ENRICHER] Starting enrichment cycle...')

  try {
    import fallbackEnricher from '../core/fallback_enricher'
    import discordService from '../services/discordService'

    const result = await fallbackEnricher.enrichMatchesBatch({ limit: 30 })
    if (result.enriched > 0) {
      logger.info(`[ENRICHER] ${result.enriched}/${result.total} enriched`)
      discordService.sendComboTicket([]).catch(() => {})
      database
        .getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
        .then((all) => {
          const top = all.filter((m) => {
            const h = parseFloat(m.home_win_probability || 0)
            const a = parseFloat(m.away_win_probability || 0)
            const p = (m.prediction || '').trim().toUpperCase()
            return (p === '1' && h >= 75) || (p === '2' && a >= 75)
          })
          if (top.length > 0) discordService.sendComboTicket(top).catch(() => {})
        })
        .catch(() => {})
    }
  } catch (e) {
    logger.warn(`[ENRICHER] Error: ${e.message}`)
  } finally {
    memoryManager.maybeGC()
    memoryManager.logMemory()
    isEnricherRunning = false
  }
}

function startPeriodicEnrichment(services, intervalMs = 20 * 60 * 1000) {
  function loop() {
    runEnrichmentCycle(services).finally(() => {
      setTimeout(loop, intervalMs).unref()
    })
  }
  setTimeout(loop, 30000).unref()
}

export = { runEnrichmentCycle, startPeriodicEnrichment }
