require('dotenv').config()
const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

const API_SECRET_KEY = process.env.API_SECRET_KEY || 'dev-secret-key-change-in-prod'
const PORT = process.env.PORT || 4000

let isRunning = false

function requireAuth(req, res, next) {
  const provided = req.headers['x-api-key'] || req.query.api_key
  if (!provided || provided !== API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ─── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    isRunning,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    version: '1.1.0'
  })
})

async function runTask(taskLabel, taskFn, req, res) {
  if (isRunning) {
    return res.status(429).json({ error: 'Worker already busy', isRunning: true })
  }
  isRunning = true
  const startTime = Date.now()
  try {
    const result = await taskFn()
    res.json({ success: true, ...result, durationMs: Date.now() - startTime })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, durationMs: Date.now() - startTime })
  } finally {
    isRunning = false
  }
}

// ─── Scrape: fixtures via HTTP API ────────────────────────
app.post('/scrape', requireAuth, async (req, res) => {
  await runTask('scrape', async () => {
    const HttpScraperService = require('../services/httpScraperService')
    const service = new HttpScraperService()
    if (!service.isAvailable()) {
      return { error: 'No API keys configured (RAPIDAPI_KEY or FOOTBALLDATA_KEY)' }
    }
    const dateStr = req.body?.date || new Date().toISOString().split('T')[0]
    const fixtures = await service.fetchAllFixtures(dateStr)
    let inserted = 0
    if (fixtures.length > 0) {
      const database = require('../core/database')
      for (const match of fixtures) {
        try { await database.insertMatch(match); inserted++ } catch (_) {}
      }
    }
    return { date: dateStr, fetched: fixtures.length, inserted }
  }, req, res)
})

// ─── Sync: BSD ─────────────────────────────────────────────
app.post('/sync/bsd', requireAuth, async (req, res) => {
  await runTask('bsd-sync', async () => {
    const bsdService = require('../services/bsdService')
    if (!bsdService.isAvailable()) return { error: 'BSD not available' }
    const count = await bsdService.fullSync()
    return { synced: count }
  }, req, res)
})

// ─── Sync: PredixSport ─────────────────────────────────────
app.post('/sync/predixsport', requireAuth, async (req, res) => {
  await runTask('predixsport-sync', async () => {
    const predixSportService = require('../services/predixSportService')
    const result = await predixSportService.syncUpcoming()
    return { synced: result?.length || 0 }
  }, req, res)
})

// ─── Sync: Big Balls Data ──────────────────────────────────
app.post('/sync/bigballsdata', requireAuth, async (req, res) => {
  await runTask('bigballsdata-sync', async () => {
    const bbs = require('../services/bigBallsDataService')
    const result = await bbs.syncUpcoming()
    return { synced: result?.length || 0 }
  }, req, res)
})

// ─── Sync: Retro-sync past matches ─────────────────────────
app.post('/sync/retro', requireAuth, async (req, res) => {
  await runTask('retro-sync', async () => {
    const retroSync = require('../services/retroSyncService')
    return await retroSync.syncPastMatches()
  }, req, res)
})

// ─── Sync: Archive finished matches ────────────────────────
app.post('/sync/archive', requireAuth, async (req, res) => {
  await runTask('archive', async () => {
    const database = require('../core/database')
    return await database.archiveFinishedMatches()
  }, req, res)
})

// ─── Sync: OpenLigaDB ──────────────────────────────────────
app.post('/sync/openligadb', requireAuth, async (req, res) => {
  await runTask('openligadb-sync', async () => {
    const openligadbService = require('../services/openligadbService')
    const count = await openligadbService.fullSync()
    return { synced: count }
  }, req, res)
})

// ─── Enrich: Proactive enrichment ──────────────────────────
app.post('/enrich', requireAuth, async (req, res) => {
  await runTask('enrich', async () => {
    const database = require('../core/database')
    const enrichedPredictions = require('../core/enriched_predictions')
    const now = Date.now()
    const twoDaysEnd = now + (2 * 24 * 60 * 60 * 1000)
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
    const needsEnrichment = matches.filter(m => {
      const ts = m.startTimestamp ? m.startTimestamp * 1000 : (m.timestamp ? new Date(m.timestamp).getTime() : 0)
      return ts > now - 3600000 && ts < twoDaysEnd && (!m.home_win_probability || parseFloat(m.home_win_probability) === 0)
    }).slice(0, 300)
    if (needsEnrichment.length === 0) return { enriched: 0 }
    const enriched = await enrichedPredictions.enrichMatches(needsEnrichment, { fastMode: false })
    let updated = 0
    for (const m of enriched) {
      await database.updatePredictions(m.id, m)
      updated++
    }
    return { enriched: updated }
  }, req, res)
})

// ─── DB Maintenance ────────────────────────────────────────
app.post('/db/maintenance', requireAuth, async (req, res) => {
  await runTask('maintenance', async () => {
    const database = require('../core/database')
    await database.maintenance()
    return {}
  }, req, res)
})

// ─── Status ────────────────────────────────────────────────
app.get('/status', requireAuth, (req, res) => {
  res.json({
    isRunning,
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
  })
})

app.listen(PORT, () => {
  console.log(`[SCRAPER WORKER] Running on port ${PORT} (HTTP-only, no Puppeteer)`)
  console.log(`[SCRAPER WORKER] Peak memory ~50MB — safe for Render free tier`)
})
