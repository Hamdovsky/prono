const axios = require('axios')
const logger = require('../core/logger')

const workerUrl = process.env.SCRAPER_WORKER_URL || ''
const apiKey = process.env.API_SECRET_KEY || ''

async function triggerScrape() {
  if (!workerUrl) {
    logger.warn('[SCRAPER BRIDGE] No SCRAPER_WORKER_URL set — running local scraper')
    return runLocalScraper()
  }

  try {
    const { data } = await axios.post(
      `${workerUrl}/scrape`,
      {},
      {
        headers: { 'x-api-key': apiKey },
        timeout: 30000,
      }
    )
    logger.info(
      `[SCRAPER BRIDGE] Worker returned: ${data.success ? 'success' : 'failed'} (${data.durationMs || 0}ms)`
    )
    return data
  } catch (err) {
    logger.error(`[SCRAPER BRIDGE] Worker call failed: ${err.message} — falling back to local`)
    return runLocalScraper()
  }
}

async function runLocalScraper() {
  // 🛡️ Skip Puppeteer-based Workflow on Render (node:22-slim has no Chromium)
  // Detected via RENDER env var OR DISABLE_SOFASCORE flag
  const onRender = !!process.env.RENDER || process.env.DISABLE_SOFASCORE === 'true'
  const hour = new Date().getHours()
  const fullScan = hour >= 4 && hour < 10

  if (onRender) {
    logger.info(
      `[SCRAPER BRIDGE] Render env detected — using HTTP scrapers only${fullScan ? ' (FULL)' : ''}`
    )
    try {
      const httpScraperService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
      const fallbackCount = await httpScraperService.processFallback({ fullScan })
      await runResilientScan().catch((e) =>
        logger.warn(`[SCRAPER BRIDGE] Resilient scan skipped: ${e.message}`)
      )
      return { success: true, fallback: true, fallbackCount }
    } catch (fbErr) {
      try {
        const scrapeService = require('./scrapeService')
        return { success: true, source: 'scrapeService' }
      } catch (sErr) {
        return {
          success: false,
          error: 'All local scrapers failed',
          fallbackError: fbErr.message,
          scrapeError: sErr.message,
        }
      }
    }
  }

  try {
    const Workflow = require('../SofascoreScraping/src/Workflow')
    const fs = require('fs')
    const path = require('path')

    const leaguesJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../leagues_ids.json'), 'utf8')
    )
    const leagues = leaguesJson.map((l) => ({
      country: l.category_name.toLowerCase().replace(/\s+/g, '-'),
      league: l.tournament_name.toLowerCase().replace(/\s+/g, '-'),
    }))

    const workflow = new Workflow(leagues)
    const result = await workflow.start()
    logger.info('[SCRAPER BRIDGE] Local scraper completed')
    // 🔑 Always refresh upcoming fixtures (J..J+2) via the resilient
    // multi-source scan so the dashboard never ends up with 0 future
    // matches (the dev Workflow path alone was leaving the DB empty of
    // upcoming fixtures). Dedup by match_key makes overlap harmless.
    try {
      await runResilientScan()
    } catch (e) {
      logger.warn(`[SCRAPER BRIDGE] Resilient scan skipped after workflow: ${e.message}`)
    }
    return { success: true, result }
  } catch (err) {
    logger.error(
      `[SCRAPER BRIDGE] Local scraper failed: ${err.message} — falling back to HTTP scraper`
    )
    try {
      const httpScraperService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
      const fallbackCount = await httpScraperService.processFallback({ fullScan })
      return { success: true, fallback: true, fallbackCount }
    } catch (fbErr) {
      return { success: false, error: err.message, fallbackError: fbErr.message }
    }
  }
}

function dateStrOffset(offset) {
  const d = new Date()
  d.setDate(d.getDate() + (offset || 0))
  return d.toISOString().split('T')[0]
}

// Runs the resilient multi-source fixture scan (Livescore primary + Sofascore
// fallback + OpenLigaDB backfill), backfilling match_key first. Best-effort.
async function runResilientScan() {
  try {
    const {
      SourceOrchestrator,
      createDefaultProviders,
      createDefaultStore,
      backfillMatchKeys,
    } = require('./sourceOrchestrator')
    const store = createDefaultStore()
    const backfilled = await backfillMatchKeys(store).catch(() => 0)
    if (backfilled > 0) logger.info(`[SCRAPER BRIDGE] match_key backfilled for ${backfilled} rows`)

    let telegram = null
    // Only load botService when Telegram is configured. Its module load can
    // block synchronously, and it is already cached inside the server anyway.
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        telegram = require('./botService')
      } catch (e) {
        logger.warn(`[SCRAPER BRIDGE] botService unavailable: ${e.message}`)
      }
    }

    const orchestrator = new SourceOrchestrator({
      providers: createDefaultProviders(),
      store,
      telegram,
    })

    // 1) Results pass: settle past fixtures with final scores (J-3..J-1).
    const resultsDates = [dateStrOffset(-3), dateStrOffset(-2), dateStrOffset(-1)]
    const results = await orchestrator.runResultsScan({ dates: resultsDates })
    if (results.updated > 0) {
      logger.info(
        `[SCRAPER BRIDGE] Results: ${results.updated} matches settled (${results.fetched} fetched)`
      )
    }

    // 2) Fixtures pass: refresh scheduled matches (J, J+1, J+2).
    const dates = [dateStrOffset(0), dateStrOffset(1), dateStrOffset(2)]
    const summary = await orchestrator.runScan({ dates })
    logger.info(
      `[SCRAPER BRIDGE] Resilient scan done: ${summary.coverage.totalUnique} unique, ${summary.coverage.new} new, ${summary.coverage.mena} MENA`
    )

    // 3) Settle any newly finished matches (best-effort).
    if (results.updated > 0) {
      try {
        const settlement = require('./settlementService')
        if (typeof settlement.settleFinishedMatches === 'function') {
          const settled = await settlement.settleFinishedMatches(true)
          logger.info(`[SCRAPER BRIDGE] Settlement done: ${JSON.stringify(settled)}`)
        }
      } catch (e) {
        logger.warn(`[SCRAPER BRIDGE] Settlement skipped: ${e.message}`)
      }
    }

    return { success: true, results, summary }
  } catch (e) {
    logger.error(`[SCRAPER BRIDGE] Resilient scan failed: ${e.message}`)
    return { success: false, error: e.message }
  }
}

let _resultsScanInFlight = false

// 🏁 Passe "résultats uniquement" (horaire) : récupère les scores finaux des
// matchs récemment terminés (J-2..aujourd'hui) et règle les pronostics, sans
// relancer le scan complet des fixtures. Léger et idempotent (upsert).
async function runResultsOnlyScan({ dates } = {}) {
  if (_resultsScanInFlight) {
    logger.info('[SCRAPER BRIDGE] Results-only scan skipped — already in flight')
    return { success: true, skipped: true }
  }
  _resultsScanInFlight = true
  try {
    const {
      SourceOrchestrator,
      createDefaultProviders,
      createDefaultStore,
      backfillMatchKeys,
    } = require('./sourceOrchestrator')
    const store = createDefaultStore()
    const backfilled = await backfillMatchKeys(store).catch(() => 0)
    if (backfilled > 0) logger.info(`[SCRAPER BRIDGE] match_key backfilled for ${backfilled} rows`)

    let telegram = null
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        telegram = require('./botService')
      } catch (e) {
        logger.warn(`[SCRAPER BRIDGE] botService unavailable: ${e.message}`)
      }
    }

    const orchestrator = new SourceOrchestrator({
      providers: createDefaultProviders(),
      store,
      telegram,
    })

    const resultsDates =
      dates || [dateStrOffset(-2), dateStrOffset(-1), dateStrOffset(0)]
    const results = await orchestrator.runResultsScan({ dates: resultsDates })
    logger.info(
      `[SCRAPER BRIDGE] Hourly results: ${results.updated} settled (${results.fetched} fetched)`
    )

    let settled = null
    if (results.updated > 0) {
      try {
        const settlement = require('./settlementService')
        if (typeof settlement.settleFinishedMatches === 'function') {
          settled = await settlement.settleFinishedMatches(true)
          logger.info(`[SCRAPER BRIDGE] Settlement done: ${JSON.stringify(settled)}`)
        }
      } catch (e) {
        logger.warn(`[SCRAPER BRIDGE] Settlement skipped: ${e.message}`)
      }
    }

    return { success: true, results, settled }
  } catch (e) {
    logger.error(`[SCRAPER BRIDGE] Results-only scan failed: ${e.message}`)
    return { success: false, error: e.message }
  } finally {
    _resultsScanInFlight = false
  }
}

module.exports = { triggerScrape, runLocalScraper, runResilientScan, runResultsOnlyScan }
