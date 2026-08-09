const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const { analyzeMatchFromDb } = require('../core/titaniumAnalyst')

router.get('/analysis/:matchId', async (req, res) => {
  try {
    const match = await database.getMatchById(req.params.matchId)
    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' })
    }
    const analysis = analyzeMatchFromDb(match)
    res.json({ success: true, analysis })
  } catch (e) {
    logger.error(`[TITANIUM] analysis error for ${req.params.matchId}: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.get('/analysis', async (req, res) => {
  try {
    const allMatches = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
    const now = Date.now()
    const lookback = now - 12 * 60 * 60 * 1000
    const endOfRange = now + 14 * 24 * 60 * 60 * 1000

    const analyses = []
    for (const m of allMatches) {
      let rawTs = m.startTimestamp
      if (!rawTs || rawTs === 0) {
        try {
          const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
          if (data && data.startTimestamp) rawTs = data.startTimestamp
        } catch {}
      }
      if (!rawTs || rawTs === 0) continue
      let tsMs
      if (typeof rawTs === 'string' && rawTs.includes('T')) {
        tsMs = new Date(rawTs).getTime()
      } else {
        tsMs = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000
      }
      if (isNaN(tsMs) || tsMs < lookback || tsMs > endOfRange) continue
      const analysis = analyzeMatchFromDb(m)
      if (analysis) analyses.push(analysis)
    }

    res.json({ success: true, count: analyses.length, analyses })
  } catch (e) {
    logger.error(`[TITANIUM] bulk analysis error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
