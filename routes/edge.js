const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const valueBetEnricher = require('../services/valueBetEnricher')
const IntegrityService = require('../services/integrity_service')
const oddsMovement = require('../services/oddsMovementService')
const asianHandicap = require('../services/asianHandicapService')

router.get('/edge', async (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0]
    const matches = await database.getMatchesByDate(dateStr)
    if (!matches || matches.length === 0) {
      return res.json({ success: true, date: dateStr, valueBets: [], alerts: [], suspicious: [] })
    }

    const valueBets = []
    const suspicious = []
    const alerts = []
    const asianHandicaps = []

    for (const match of matches) {
      const enriched = await valueBetEnricher.enrichMatch(match).catch(() => null)
      const integrity = await IntegrityService.analyzeMatch(match, enriched || {}).catch(() => ({ risks: [], integrityScore: 0 }))

      if (integrity.integrityScore >= 5) {
        suspicious.push({
          id: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league || match.competition,
          score: integrity.integrityScore,
          risks: integrity.risks,
        })
      }

      if (enriched && enriched.valueBets) {
        for (const vb of enriched.valueBets) {
          if (vb.valuePct >= 5) {
            valueBets.push({
              id: match.id,
              date: dateStr,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              league: match.league || match.competition,
              kickoff: match.timestamp || match.date,
              outcome: vb.outcome,
              marketOdds: vb.marketOdds,
              fairOdds: vb.fairOdds,
              valuePercent: Math.round(vb.valuePct),
              confidence: enriched.confidence,
            })
          }
        }
      }

      const ah = asianHandicap.analyzeMatch(match, {
        h: enriched?.fairOdds?.home ? 1 / enriched.fairOdds.home : null,
        a: enriched?.fairOdds?.away ? 1 / enriched.fairOdds.away : null,
        xgH: enriched?.homeXG ?? null,
        xgA: enriched?.awayXG ?? null,
      })
      if (ah && ah.isValue) {
        asianHandicaps.push({
          id: match.id,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          league: match.league || match.competition,
          marketLine: ah.marketLine,
          modelLine: ah.modelLine,
          modelConfidence: ah.modelConfidence,
          homeAHodds: ah.homeAHodds,
          awayAHodds: ah.awayAHodds,
          lineDisagreement: ah.lineDisagreement,
          steam: ah.steam,
        })
      }
    }

    const oddsAlerts = oddsMovement.snapshotOdds(matches)
    for (const [matchId, movement] of oddsAlerts) {
      if (movement.steamHome || movement.steamAway || movement.steamDraw) {
        const match = matches.find(m => String(m.id) === matchId)
        if (match) {
          alerts.push({
            id: matchId,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            steamHome: movement.steamHome,
            steamAway: movement.steamAway,
            steamDraw: movement.steamDraw,
          })
        }
      }
    }

    valueBets.sort((a, b) => b.valuePercent - a.valuePercent)
    asianHandicaps.sort((a, b) => b.lineDisagreement - a.lineDisagreement)

    res.json({
      success: true,
      date: dateStr,
      totalValueBets: valueBets.length,
      totalAlerts: alerts.length,
      totalSuspicious: suspicious.length,
      totalAsianHandicaps: asianHandicaps.length,
      valueBets: valueBets.slice(0, 30),
      alerts: alerts.slice(0, 10),
      suspicious: suspicious.slice(0, 10),
      asianHandicaps: asianHandicaps.slice(0, 15),
    })
  } catch (e) {
    logger.error('[EDGE] Error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
