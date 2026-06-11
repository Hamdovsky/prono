require('dotenv').config()
const express = require('express')
const cors = require('cors')
const axios = require('axios')

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
    version: '1.0.0'
  })
})

// ─── Trigger Scrape (HTTP API only — no Puppeteer) ────────
app.post('/scrape', requireAuth, async (req, res) => {
  if (isRunning) {
    return res.status(429).json({ error: 'Scraper already running', isRunning: true })
  }

  isRunning = true
  const startTime = Date.now()
  const dateStr = req.body?.date || new Date().toISOString().split('T')[0]

  try {
    const HttpScraperService = require('../services/httpScraperService')
    const service = new HttpScraperService()

    if (!service.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'No API keys configured (RAPIDAPI_KEY or FOOTBALLDATA_KEY)',
        durationMs: Date.now() - startTime
      })
    }

    const fixtures = await service.fetchAllFixtures(dateStr)
    let inserted = 0
    if (fixtures.length > 0) {
      const database = require('../core/database')
      for (const match of fixtures) {
        try {
          await database.insertMatch(match)
          inserted++
        } catch (e) {
          // skip duplicate
        }
      }
    }

    res.json({
      success: true,
      date: dateStr,
      fetched: fixtures.length,
      inserted,
      durationMs: Date.now() - startTime
    })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      durationMs: Date.now() - startTime
    })
  } finally {
    isRunning = false
  }
})

// ─── Trigger Single Match Enrichment ───────────────────────
app.post('/scrape/match', requireAuth, async (req, res) => {
  const startTime = Date.now()
  try {
    const { matchId, homeTeam, awayTeam, league } = req.body
    if (!matchId) {
      return res.status(400).json({ error: 'matchId required' })
    }

    const HttpScraperService = require('../services/httpScraperService')
    const service = new HttpScraperService()

    const data = await service.enrichSingleMatch({ id: matchId, homeTeam, awayTeam, league })

    res.json({
      success: true,
      data,
      durationMs: Date.now() - startTime
    })
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      durationMs: Date.now() - startTime
    })
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
