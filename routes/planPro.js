const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const proPlanEngine = require('../services/proPlanEngine')
const proPlanBankroll = require('../services/proPlanBankroll')
const topPicksEngine = require('../services/topPicksEngine')

/**
 * GET /api/plan-pro/summary
 * État de la bankroll (DT), palier, progression 100 → 400, statistiques, règles.
 */
router.get('/plan-pro/summary', (req, res) => {
  try {
    const summary = proPlanBankroll.getSummary()
    if (!summary) return res.status(500).json({ success: false, error: 'DB indisponible' })
    res.json({ success: true, ...summary })
  } catch (e) {
    logger.error(`[PRO-PLAN] /summary failed: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/plan-pro/1x2/daily?limit=5&days=14
 * Picks 1X2 purs du jour (discipline ligues + règle du nul) avec mise recommandée.
 */
router.get('/plan-pro/1x2/daily', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5
    const days = parseInt(req.query.days) || 14
    const result = await proPlanEngine.selectProPicks1X2({ limit, days })
    const bankroll = proPlanBankroll.getState()
    const tier = proPlanBankroll.getTier()
    const picks = result.picks.map((p) => {
      const stake = proPlanBankroll.recommendStake(p.modelProbability, p.odds)
      return { ...p, stakeDt: stake.stakeDt, stakePct: stake.stakePct, kellyCapped: stake.capped }
    })
    res.json({
      success: true,
      date: new Date().toISOString().slice(0, 10),
      count: picks.length,
      picks,
      bankroll,
      tier,
      analyzed: result.analyzed,
      rejected: result.rejected,
      filters: result.filters,
      generatedAt: result.generatedAt,
    })
  } catch (e) {
    logger.error(`[PRO-PLAN] /1x2/daily failed: ${e.message}`, { stack: e.stack })
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/plan-pro/secondary?limit=5&days=14
 * Onglets secondaires : Over 2.5 et BTTS (topPicksEngine, marchés séparés).
 */
router.get('/plan-pro/secondary', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 10)
    const days = parseInt(req.query.days) || 14
    const result = await topPicksEngine.selectTopPicksOfDay({ limit, days, markets: ['Over 2.5', 'BTTS'] })
    const grouped = {
      'Over 2.5': result.picks.filter((p) => p.marketType === 'Over 2.5'),
      BTTS: result.picks.filter((p) => p.marketType === 'BTTS'),
    }
    res.json({
      success: true,
      date: new Date().toISOString().slice(0, 10),
      count: result.picks.length,
      grouped,
      generatedAt: result.generatedAt,
    })
  } catch (e) {
    logger.error(`[PRO-PLAN] /secondary failed: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/plan-pro/stables?limit=5&days=14
 * Plan "Stables" : Double Chance à proba calibrée et EV réel positif.
 */
router.get('/plan-pro/stables', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5
    const days = parseInt(req.query.days) || 14
    const result = await topPicksEngine.selectStablePicks({ limit, days })
    const bankroll = proPlanBankroll.getState()
    const tier = proPlanBankroll.getTier()
    const picks = result.picks.map((p) => {
      const stake = proPlanBankroll.recommendStake(p.modelProbability, p.odds)
      return { ...p, stakeDt: stake.stakeDt, stakePct: stake.stakePct, kellyCapped: stake.capped }
    })
    res.json({
      success: true,
      date: new Date().toISOString().slice(0, 10),
      count: picks.length,
      picks,
      bankroll,
      tier,
      analyzed: result.analyzed,
      rejected: result.rejected,
      filters: result.filters,
      generatedAt: result.generatedAt,
    })
  } catch (e) {
    logger.error(`[PRO-PLAN] /stables failed: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/plan-pro/1x2/history
 * Historique des règlements du plan.
 */
router.get('/plan-pro/1x2/history', (req, res) => {
  try {
    const bets = proPlanBankroll.getHistory()
    res.json({ success: true, count: bets.length, bets })
  } catch (e) {
    logger.error(`[PRO-PLAN] /1x2/history failed: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * POST /api/plan-pro/1x2/settle
 * Body : { matchId?, home?, away?, league?, pick, odds, prob?, edge?, result: 'WON'|'LOST'|'PUSH' }
 */
router.post('/plan-pro/1x2/settle', (req, res) => {
  try {
    const b = req.body || {}
    if (!b.pick || !b.odds) {
      return res.status(400).json({ success: false, error: 'pick et odds requis' })
    }
    const outcome = proPlanBankroll.settleBet(b)
    const summary = proPlanBankroll.getSummary()
    res.json({ success: true, ...outcome, summary })
  } catch (e) {
    logger.error(`[PRO-PLAN] /1x2/settle failed: ${e.message}`)
    res.status(400).json({ success: false, error: e.message })
  }
})

module.exports = router
