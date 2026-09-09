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
  // Le chemin « Workflow Puppeteer » (SofascoreScraping) est SORTI du pipeline
  // cron/boot (2026-09-09) : ses sockets pouvaient hang sans timeout (le
  // startup-resume restait bloqué avant runResilientScan → DB jamais peuplée).
  // Le pipeline utilise désormais le scan résilient HTTP multi-sources :
  // sofascore-py (PixelRAG/curl_cffi) → livescore → openligadb.
  // Le Workflow reste utilisable à la main via « npm run scraper ».
  return runResilientScan()
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

    // 🔥 Détaché : le pré-chauffage visuel ne doit jamais retarder le scan.
    warmVisualCache()
      .then((w) => {
        if (w && w.warmed > 0)
          logger.info(`[SCRAPER BRIDGE] Visual cache warm: ${w.warmed}/${w.total} events pre-enriched`)
      })
      .catch(() => {})

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

// 🔥 [CACHE CHAUD] Après un scan fixtures, on pré-chauffe le cache visuel :
// PixelRAG agrège lineups/injuries/stats/H2H pour les prochains matchs
// 'sofascore_*' (J..J+2) afin que /api/predict trouve l'enrichissement déjà
// prêt (sinon 1ᵉʳ clic = 3-5 s d'attente Sofascore). Détaché (jamais await),
// best-effort, VISUAL_WARM_ENABLED=false pour désactiver.
async function warmVisualCache({ limit = 15 } = {}) {
  if (process.env.VISUAL_WARM_ENABLED === 'false') return { warmed: 0, skipped: true }
  const base = process.env.PIXELRAG_URL || 'http://127.0.0.1:30002'
  try {
    const db = require('../core/database')
    const nowSec = Math.floor(Date.now() / 1000)
    const rows = db
      .prepare(
        "SELECT id FROM matches WHERE id LIKE 'sofascore_%' AND startTimestamp > ? AND startTimestamp < ? ORDER BY startTimestamp ASC LIMIT ?"
      )
      .all(nowSec, nowSec + 48 * 3600, limit)
    let warmed = 0
    for (const r of rows) {
      const eid = String(r.id).replace('sofascore_', '')
      if (!/^\d+$/.test(eid)) continue
      try {
        const res = await fetch(`${base}/enrich/${eid}`, { signal: AbortSignal.timeout(9000) })
        const j = await res.json()
        if (j && j.success === true) warmed++
      } catch (_) {
        /* PixelRAG down ou event sans données — on s'arrête au 1ᵉʳ refus */
        if (!warmed && rows.indexOf(r) > 2) break
      }
    }
    return { warmed, total: rows.length }
  } catch (e) {
    return { warmed: 0, error: e.message }
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

module.exports = { triggerScrape, runLocalScraper, runResilientScan, runResultsOnlyScan, warmVisualCache }
