const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const valueBetEnricher = require('../services/valueBetEnricher')

/**
 * GET /api/value-bets
 * Returns enriched value bets for upcoming matches
 * Query params:
 *   date  - YYYY-MM-DD (default: today)
 *   league - filter by league code (optional)
 *   minValue - minimum value % to include (default: 5)
 */
router.get('/value-bets', async (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0]
    const minValue = parseFloat(req.query.minValue) || 5
    const leagueFilter = req.query.league || null

    let matches = await database.getMatchesByDate(dateStr)
    if (!matches || matches.length === 0) {
      matches = await database.getMatchesByStatuses(['scheduled', 'upcoming', 'NOT_STARTED', 'NS'])
    }
    if (!matches || matches.length === 0) {
      return res.json({ success: true, date: dateStr, total: 0, valueBets: [] })
    }

    let filtered = matches
    if (leagueFilter) {
      filtered = matches.filter(
        (m) =>
          (m.league || '').toLowerCase() === leagueFilter.toLowerCase() ||
          (m.competition || '').toLowerCase() === leagueFilter.toLowerCase()
      )
    }

    const results = []
    for (const match of filtered) {
      const enriched = await valueBetEnricher.enrichMatch(match)
      if (enriched && enriched.valueBets && enriched.valueBets.length > 0) {
        for (const vb of enriched.valueBets) {
          if (vb.valuePct >= minValue) {
            results.push({
              id: match.id,
              date: dateStr,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              league: match.league || match.competition,
              kickoff: match.timestamp || match.date,
              outcome: vb.outcome,
              marketOdds: vb.marketOdds,
              fairOdds: vb.fairOdds,
              valuePercent: vb.valuePct,
              confidence: enriched.confidence,
              homeXG: enriched.homeXG,
              awayXG: enriched.awayXG,
              adjustments: enriched.adjustmentFactors,
            })
          }
        }
      }
    }

    results.sort((a, b) => b.valuePercent - a.valuePercent)

    res.json({
      success: true,
      date: dateStr,
      total: results.length,
      valueBets: results.slice(0, 50),
    })
  } catch (e) {
    logger.error(`[VALUE-BETS] Error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/value-bets/enrich/:matchId
 * Enrich a single match by ID
 */
router.get('/value-bets/enrich/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params
    const dateStr = new Date().toISOString().split('T')[0]
    const matches = await database.getMatchesByDate(dateStr)
    const match = matches.find((m) => String(m.id) === String(matchId))

    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' })
    }

    const enriched = await valueBetEnricher.enrichMatch(match)
    res.json({ success: true, match: enriched })
  } catch (e) {
    logger.error(`[VALUE-BETS] Enrich error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
