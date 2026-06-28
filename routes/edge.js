const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const valueBetEnricher = require('../services/valueBetEnricher')
const IntegrityService = require('../services/integrity_service')
const oddsMovement = require('../services/oddsMovementService')
const asianHandicap = require('../services/asianHandicapService')
const marketAnalysis = require('../services/marketAnalysisService')

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
    const markets = { overUnder: [], btts: [], doubleChance: [], htFt: [], corners: [], cards: [], playerProps: [] }

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

      const mkts = marketAnalysis.analyzeAll(match, {
        h: enriched?.fairOdds?.home ? 1 / enriched.fairOdds.home : null,
        d: enriched?.fairOdds?.draw ? 1 / enriched.fairOdds.draw : null,
        a: enriched?.fairOdds?.away ? 1 / enriched.fairOdds.away : null,
        xgH: enriched?.homeXG ?? null,
        xgA: enriched?.awayXG ?? null,
      })
      if (mkts) {
        for (const ou of mkts.overUnder) {
          if (ou.fairOver && ou.fairOver > 1.5) {
            markets.overUnder.push({
              id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
              league: match.league || match.competition,
              line: ou.line, expectedTotal: ou.expectedTotal, overProb: ou.overProb,
              fairOver: ou.fairOver, fairUnder: ou.fairUnder,
            })
          }
        }
        if (mkts.btts.bttsProb > 0.55) {
          markets.btts.push({
            id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            league: match.league || match.competition,
            bttsProb: mkts.btts.bttsProb, fairBttsOdds: mkts.btts.fairBttsOdds,
          })
        }
        markets.doubleChance.push({
          id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
          league: match.league || match.competition,
          options: mkts.doubleChance,
        })
        markets.htFt.push({
          id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
          league: match.league || match.competition,
          halfTime: mkts.htFt.halfTime, fullTime: mkts.htFt.fullTime,
          topPicks: mkts.htFt.topPick,
        })
        if (mkts.corners.length) {
          markets.corners.push({
            id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            league: match.league || match.competition,
            lines: mkts.corners,
          })
        }
        if (mkts.cards.length) {
          markets.cards.push({
            id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            league: match.league || match.competition,
            lines: mkts.cards,
          })
        }
        if (mkts.playerProps.length) {
          markets.playerProps.push({
            id: match.id, homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            props: mkts.playerProps.slice(0, 5),
          })
        }
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
      totalMarkets: {
        overUnder: markets.overUnder.length,
        btts: markets.btts.length,
        doubleChance: markets.doubleChance.length,
        htFt: markets.htFt.length,
        corners: markets.corners.length,
        cards: markets.cards.length,
        playerProps: markets.playerProps.length,
      },
      valueBets: valueBets.slice(0, 30),
      alerts: alerts.slice(0, 10),
      suspicious: suspicious.slice(0, 10),
      asianHandicaps: asianHandicaps.slice(0, 15),
      markets: {
        overUnder: markets.overUnder.slice(0, 10),
        btts: markets.btts.slice(0, 10),
        doubleChance: markets.doubleChance.slice(0, 10),
        htFt: markets.htFt.slice(0, 10),
        corners: markets.corners.slice(0, 10),
        cards: markets.cards.slice(0, 10),
        playerProps: markets.playerProps.slice(0, 10),
      },
    })
  } catch (e) {
    logger.error('[EDGE] Error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
