const express = require('express')
const router = express.Router()
const database = require('../core/database')
const logger = require('../core/logger')

function pickWon(pick, sh, sa) {
  const p = (pick || '').toString().trim().toUpperCase()
  if (p === '1' || p === 'HOME') return sh > sa
  if (p === '2' || p === 'AWAY') return sa > sh
  if (p === 'X' || p === 'DRAW') return sh === sa
  if (p === '1X') return sh >= sa
  if (p === 'X2') return sa >= sh
  if (p === '12') return sh !== sa
  return false
}

function getOddsForPick(match, pick) {
  const p = (pick || '').toString().trim().toUpperCase()
  if (p === '1' || p === 'HOME')
    return parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 0)
  if (p === '2' || p === 'AWAY')
    return parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 0)
  if (p === 'X' || p === 'DRAW') return parseFloat(match.odds_draw || 0)
  if (p === '1X' || p === 'X2' || p === '12') {
    const h =
      parseFloat(match.odds_home || match.best_odds_home || match.display_odds_home || 2) || 2
    const a =
      parseFloat(match.odds_away || match.best_odds_away || match.display_odds_away || 2) || 2
    const d = parseFloat(match.odds_draw || 3) || 3
    if (p === '1X') {
      const prob = 1 / h + 1 / d
      return prob > 0 ? 1 / prob : 0
    }
    if (p === 'X2') {
      const prob = 1 / a + 1 / d
      return prob > 0 ? 1 / prob : 0
    }
    if (p === '12') {
      const prob = 1 / h + 1 / a
      return prob > 0 ? 1 / prob : 0
    }
  }
  return 0
}

function computeStats(rows) {
  const total = rows.length
  const won = rows.filter((r) => r.result === 'won').length
  const lost = rows.filter((r) => r.result === 'lost').length
  const pending = rows.filter((r) => r.result === 'pending').length
  const voided = rows.filter((r) => r.result === 'void').length
  const totalStaked = rows.reduce((s, r) => s + (r.stake || 0), 0)
  const totalReturned = rows.reduce(
    (s, r) => (r.result === 'won' ? s + (r.stake || 0) * (r.odds || 1) : s),
    0
  )
  const netProfit = totalReturned - totalStaked
  const roi = totalStaked > 0 ? Math.round((netProfit / totalStaked) * 10000) / 100 : 0
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 10000) / 100 : 0
  return {
    total,
    won,
    lost,
    pending,
    voided,
    totalStaked: Math.round(totalStaked * 100) / 100,
    totalReturned: Math.round(totalReturned * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    roi,
    winRate,
  }
}

router.get('/', (req, res) => {
  try {
    const db = database.db
    const rows = db.prepare('SELECT * FROM bets ORDER BY date DESC, id DESC').all()
    res.json({ success: true, bets: rows, stats: computeStats(rows) })
  } catch (e) {
    logger.error(`[BETS] GET error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post('/', (req, res) => {
  try {
    const { match_label, league, pick, odds, stake, result = 'pending', note, date } = req.body
    if (!match_label || !pick || !odds || stake === undefined) {
      return res
        .status(400)
        .json({ success: false, error: 'match_label, pick, odds, stake requis' })
    }
    const db = database.db
    const profit =
      result === 'won'
        ? Math.round(((stake || 0) * (odds || 1) - (stake || 0)) * 100) / 100
        : result === 'lost'
          ? -(stake || 0)
          : 0
    const info = db
      .prepare(
        'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, note, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        match_label,
        league || '',
        pick,
        odds,
        stake,
        result,
        profit,
        note || '',
        date || new Date().toISOString().split('T')[0]
      )
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(info.lastInsertRowid)
    res.json({ success: true, bet })
  } catch (e) {
    logger.error(`[BETS] POST error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params
    const { match_label, league, pick, odds, stake, result, note, date } = req.body
    const db = database.db
    const existing = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ success: false, error: 'Bet non trouvé' })
    const finalResult = result !== undefined ? result : existing.result
    const finalStake = stake !== undefined ? stake : existing.stake
    const finalOdds = odds !== undefined ? odds : existing.odds
    const profit =
      finalResult === 'won'
        ? Math.round((finalStake * finalOdds - finalStake) * 100) / 100
        : finalResult === 'lost'
          ? -finalStake
          : 0
    db.prepare(
      'UPDATE bets SET match_label=?, league=?, pick=?, odds=?, stake=?, result=?, profit=?, note=?, date=? WHERE id=?'
    ).run(
      match_label || existing.match_label,
      league !== undefined ? league : existing.league,
      pick || existing.pick,
      finalOdds,
      finalStake,
      finalResult,
      profit,
      note !== undefined ? note : existing.note,
      date || existing.date,
      id
    )
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    res.json({ success: true, bet })
  } catch (e) {
    logger.error(`[BETS] PUT error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = database.db
    const existing = db.prepare('SELECT * FROM bets WHERE id = ?').get(id)
    if (!existing) return res.status(404).json({ success: false, error: 'Bet non trouvé' })
    db.prepare('DELETE FROM bets WHERE id = ?').run(id)
    res.json({ success: true })
  } catch (e) {
    logger.error(`[BETS] DELETE error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

router.post('/import', (req, res) => {
  try {
    const db = database.db
    const rows = db
      .prepare(
        'SELECT * FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY archived_at DESC LIMIT 200'
      )
      .all()
    let imported = 0
    for (const row of rows) {
      let fullData = null
      try {
        fullData = JSON.parse(row.fullData || '{}')
      } catch (_) {
        continue
      }
      const quant = fullData.quant || fullData.enriched?.quant || {}
      const pick = quant.main_pick || fullData.main_pick || fullData.pick
      if (!pick) continue
      const existing = db
        .prepare('SELECT id FROM bets WHERE match_label = ? AND pick = ?')
        .get(`${row.homeTeam} vs ${row.awayTeam}`, pick)
      if (existing) continue
      const sh = row.scoreHome,
        sa = row.scoreAway
      const won = pickWon(pick, sh, sa)
      const odds = getOddsForPick(fullData, pick)
      if (odds <= 0) continue
      const stake = 1
      const profit = won ? Math.round((odds - 1) * 100) / 100 : -1
      db.prepare(
        'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        `${row.homeTeam} vs ${row.awayTeam}`,
        row.league || '',
        pick,
        Math.round(odds * 100) / 100,
        stake,
        won ? 'won' : 'lost',
        profit,
        row.timestamp ? row.timestamp.split('T')[0] : new Date().toISOString().split('T')[0]
      )
      imported++
    }
    res.json({ success: true, imported })
  } catch (e) {
    logger.error(`[BETS] IMPORT error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
