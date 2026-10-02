const express = require('express')
const router = express.Router()
const database = require('../core/database')
const logger = require('../core/logger')
const integrityScorer = require('../services/integrityScorer')

/**
 * GET /api/integrity/suspects
 * Matchs terminés dont le score d'intégrité a posteriori dépasse un seuil.
 * ⚠️ Anomalie statistique, PAS une preuve de match-fixing.
 *
 * ?target=matches|historical|both (défaut both — le xG vit surtout dans
 * historical_matches : 0/1463 sur matches contre 2987/12563 sur historical)
 */
router.get('/suspects', async (req, res) => {
  try {
    const minScore = Math.max(0, parseInt(req.query.minScore, 10) || 50)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const league = req.query.league || null
    const strict = req.query.strict === '1'
    const target = ['matches', 'historical', 'both'].includes(req.query.target) ? req.query.target : 'both'

    const params = [minScore]
    let where = 'WHERE fixing_score >= ?'
    if (league) {
      where += ' AND league = ?'
      params.push(league)
    }

    let rows = []
    if (target === 'matches' || target === 'both') {
      rows = rows.concat((await database
        .prepare(`SELECT * FROM matches ${where} ORDER BY fixing_score DESC, timestamp DESC LIMIT ?`)
        .all(...params, limit)).map((r) => ({ ...r, _src: 'matches' })))
    }
    if (target === 'historical' || target === 'both') {
      rows = rows.concat((await database
        .prepare(`SELECT * FROM historical_matches ${where} ORDER BY fixing_score DESC, timestamp DESC LIMIT ?`)
        .all(...params, limit)).map((r) => ({ ...r, _src: 'historical' })))
    }
    rows.sort((a, b) => (b.fixing_score || 0) - (a.fixing_score || 0))
    rows = rows.slice(0, limit)

    const suspects = rows.map((m) => {
      const r = integrityScorer.scoreMatch(m)
      return {
        id: m.id,
        source: m._src,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        league: m.league,
        score: `${m.scoreHome}-${m.scoreAway}`,
        timestamp: m.timestamp,
        fixingScore: r.fixing_score,
        verdict: r.verdict,
        flags: r.flags,
        lowConfidence: r.low_confidence,
        coverage: r.coverage,
        note: r.note,
      }
    })

    // En mode strict on masque les matchs dont le score n'est pas fiable
    const filtered = strict ? suspects.filter((s) => !s.lowConfidence) : suspects

    res.json({
      success: true,
      target,
      minScore,
      strict,
      count: filtered.length,
      disclaimer:
        "Anomalie statistique a posteriori. Ne constitue PAS une preuve de match-fixing et ne doit jamais être présentée comme telle.",
      suspects: filtered,
    })
  } catch (e) {
    logger.error('[INTEGRITY] suspects error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/integrity/match/:id — détail complet d'un match scoré.
 * Cherche d'abord dans `matches`, puis dans `historical_matches`.
 */
router.get('/match/:id', async (req, res) => {
  try {
    let m = await database.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id)
    let source = 'matches'
    if (!m) {
      m = await database.prepare('SELECT * FROM historical_matches WHERE id = ?').get(req.params.id)
      source = 'historical'
    }
    if (!m) return res.status(404).json({ success: false, error: 'Match introuvable' })

    const result = integrityScorer.scoreMatch(m)
    res.json({
      success: true,
      match: {
        id: m.id,
        source,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        league: m.league,
        score: `${m.scoreHome}-${m.scoreAway}`,
        timestamp: m.timestamp,
      },
      integrity: result,
    })
  } catch (e) {
    logger.error('[INTEGRITY] match detail error:', e.message)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
