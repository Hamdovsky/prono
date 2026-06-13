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

  // Auto-reset on client disconnect so flag doesn't stick
  const onClose = () => { isRunning = false }
  req.on('close', onClose)

  try {
    const result = await taskFn()
    res.json({ success: true, ...result, durationMs: Date.now() - startTime })
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, durationMs: Date.now() - startTime })
  } finally {
    isRunning = false
    req.off('close', onClose)
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
      return ts > now - 3600000 && ts < twoDaysEnd
    }).slice(0, 300)
    if (needsEnrichment.length === 0) return { enriched: 0 }
    const enriched = await enrichedPredictions.enrichMatches(needsEnrichment, { fastMode: false, force: true })
    
    // DEBUG: capture first match details
    let debugInfo = {}
    if (enriched.length > 0) {
      const m = enriched[0]
      debugInfo = {
        keys: Object.keys(m),
        ai_source: m.ai_source,
        home_win_probability: m.home_win_probability,
        expected_score: m.expected_score,
        enriched_keys: m.enriched ? Object.keys(m.enriched) : 'none'
      }
      console.log('[WORKER ENRICH DEBUG]', JSON.stringify(debugInfo))
    }
    
    let updated = 0
    for (const m of enriched) {
      const result = await database.updatePredictions(m.id, m)
      if (!result) console.log(`[WORKER ENRICH] updatePredictions returned false for ${m.id}`)
      updated++
    }
    
    // Invalider le cache du serveur principal
    try {
      const axios = require('axios')
      const MAIN_URL = process.env.MAIN_SERVER_URL || 'https://prono-k6gc.onrender.com'
      await axios.post(`${MAIN_URL}/api/invalidate-cache`, 
        { prefixes: ['upcoming', 'live', 'combos'] },
        { headers: { 'x-api-key': API_SECRET_KEY, 'Content-Type': 'application/json' }, timeout: 5000 }
      )
    } catch (_) {}
    return { enriched: updated, debug: debugInfo }
  }, req, res)
})

// ─── Sync: GoalModel MLE Parameters (via FastAPI) ────────────
app.post('/sync/goalmodel', requireAuth, async (req, res) => {
  await runTask('goalmodel-fit', async () => {
    const https = require('https')
    const path = require('path')
    const fastApiUrl = process.env.FASTAPI_URL || 'https://prono-fastapi.onrender.com'

    // Query local SQLite for recent match history
    let matchesData = {}
    const leagueFilter = req.body?.leagues || []
    const dbPath = path.resolve(__dirname, '../data/historical_archive.sqlite')

    try {
      const Database = require('better-sqlite3')
      const fs = require('fs')
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath)
        const leagues = leagueFilter.length > 0
          ? leagueFilter
          : db.prepare(
              "SELECT league FROM historical_matches GROUP BY league HAVING COUNT(*) >= 10 ORDER BY COUNT(*) DESC LIMIT 50"
            ).all().map(r => r.league)

        for (const league of leagues) {
          const rows = db.prepare(
            "SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp FROM historical_matches WHERE league = ? ORDER BY timestamp DESC LIMIT 200"
          ).all(league)
          if (rows.length >= 10) {
            matchesData[league] = rows.map(r => ({
              homeTeam: r.homeTeam,
              awayTeam: r.awayTeam,
              scoreHome: r.scoreHome,
              scoreAway: r.scoreAway,
              timestamp: r.timestamp
            }))
          }
        }
        db.close()
      }
    } catch (e) {
      // fallback: empty matchesData
    }

    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ leagues: Object.keys(matchesData), matches_data: matchesData })
      const urlObj = new URL(fastApiUrl + '/goalmodel/fit')
      const opts = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 180000
      }
      const req = https.request(opts, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch (e) { resolve({ raw: data, error: e.message }) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
      req.write(body)
      req.end()
    })
    return { fitted: result }
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

// ─── Reset: force-clear isRunning if stuck ─────────────────
app.post('/reset', requireAuth, (req, res) => {
  isRunning = false
  res.json({ success: true, message: 'isRunning reset to false' })
})

// ─── DB Test: debug Postgres connection ────────────────────
app.get('/db-test', requireAuth, async (req, res) => {
  try {
    const conn = require('../core/pg_connector')
    const dbUrl = (process.env.DATABASE_URL || '')
    const dbUrlFirst50 = dbUrl.slice(0, 55)
    const p = conn.getPool()
    const isPg = conn.usingPostgres()
    let tableCount = null, sampleRow = null, queryError = null, aiSourceCheck = null, columns = null
    try {
      const r = await conn.query('SELECT COUNT(*) as cnt FROM matches')
      tableCount = r.rows?.[0]?.cnt
      // Get columns
      const colR = await conn.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'matches' ORDER BY ordinal_position")
      columns = colR.rows?.map(x => x.column_name)
      // Get fullData sample with ai_source
      const r2 = await conn.query('SELECT id, status, "fullData" FROM matches LIMIT 3')
      sampleRow = r2.rows?.map(x => {
        let ai_source = null, fullData_str = null
        if (x.fullData) {
          try {
            const parsed = typeof x.fullData === 'string' ? JSON.parse(x.fullData) : x.fullData
            ai_source = parsed.ai_source
            fullData_str = JSON.stringify(parsed).slice(0, 200)
          } catch(e) {
            ai_source = 'PARSE_ERR'
          }
        }
        return { id: x.id, status: x.status, ai_source, fullData_preview: fullData_str }
      })
      // Count ai_source values with correct quoting
      const r3 = await conn.query("SELECT COUNT(*) as cnt FROM matches WHERE \"fullData\"::text LIKE '%TITANIUM_QUANT_V4%'")
      const r4 = await conn.query("SELECT COUNT(*) as cnt FROM matches WHERE \"fullData\"::text LIKE '%TITANIUM_ELITE_V3%'")
      aiSourceCheck = { quant_v4: r3.rows?.[0]?.cnt, elite_v3: r4.rows?.[0]?.cnt }
    } catch (qe) {
      queryError = qe.message
    }
    res.json({
      using_postgres: isPg,
      table_count: tableCount,
      columns_fullData: columns?.includes('fullData'),
      columns_fulldata: columns?.includes('fulldata'),
      columns_ai_source: columns?.includes('ai_source'),
      all_columns: columns,
      sample: sampleRow,
      ai_source_in_json: aiSourceCheck,
      query_error: queryError
    })
  } catch (e) {
    res.json({ error: e.message, stack: e.stack?.slice(0, 500) })
  }
})

// ─── Test updatePredictions directly ──────────────────────
app.post('/test-update', requireAuth, async (req, res) => {
  try {
    const database = require('../core/database')
    const enrichedPredictions = require('../core/enriched_predictions')
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])
    const testMatch = matches[0]
    if (!testMatch) return res.json({ error: 'No matches' })
    
    // Enrich one match
    const enriched = await enrichedPredictions.enrichMatches([testMatch], { fastMode: false, force: true })
    const m = enriched[0]
    
    // Debug: what does enriched match have?
    const debug = {
      id: m.id,
      ai_source: m.ai_source,
      home_win_probability: m.home_win_probability,
      draw_probability: m.draw_probability,
      away_win_probability: m.away_win_probability,
      expected_score: m.expected_score,
      verdict: m.verdict
    }
    
    // Call updatePredictions
    const result = await database.updatePredictions(m.id, m)
    
    // Read back from DB
    const conn = require('../core/pg_connector')
    const r = await conn.query('SELECT "fullData", home_win_probability, ai_source FROM matches WHERE id = $1', [m.id])
    const row = r.rows?.[0]
    let fullData_ai_source = null, fullData_hwp = null
    if (row?.fullData) {
      try {
        const parsed = typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData
        fullData_ai_source = parsed.ai_source
        fullData_hwp = parsed.home_win_probability
      } catch(e) {}
    }
    
    res.json({
      input_debug: debug,
      update_result: result,
      db_after: {
        column_hwp: row?.home_win_probability,
        column_ai_source: row?.ai_source,
        fullData_ai_source: fullData_ai_source,
        fullData_hwp: fullData_hwp
      }
    })
  } catch (e) {
    res.json({ error: e.message, stack: e.stack?.slice(0, 500) })
  }
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
