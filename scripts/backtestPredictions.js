#!/usr/bin/env node
/**
 * scripts/backtestPredictions.js
 *
 * Backtest offline "avant / après" du moteur de pronos sur de vrais matchs
 * terminés (data/historical_archive.sqlite). Rejoue l'ANCIEN moteur (avant P2)
 * et le NOUVEAU (après P2) sur les mêmes matchs avec les mêmes cotes, puis
 * compare le taux de réussite des picks (main_pick, O/U 2.5 implicite, BTTS).
 *
 * Différences couvertes par le backtest (P2) :
 *   - dérivation xG-from-odds draw-aware (le nul n'est plus jeté)
 *   - dispersion hash du nom d'équipes uniquement si insufficient_data=1
 *
 * Usage : node scripts/backtestPredictions.js [--limit N] [--onlyOdds]
 */

const path = require('path')
const Database = require('better-sqlite3')
const StatisticalEngine = require('../core/services/StatisticalEngine')
const QuantumQuantEngine = require('../core/QuantumQuantEngine')
const { evaluatePrediction } = require('../services/settlementService')

const ARCHIVE_DB =
  process.env.ARCHIVE_DB || path.join(__dirname, '..', 'data', 'historical_archive.sqlite')

function classifyMarket(prediction) {
  if (!prediction) return 'UNKNOWN'
  const p = String(prediction).toUpperCase()
  if (p === '1' || p === 'X' || p === '2') return '1X2'
  if (p === '1X' || p === '12' || p === 'X2') return 'DC'
  if (p.startsWith('OVER') || p.startsWith('UNDER') || p.startsWith('O/U')) return 'OU'
  if (p.startsWith('BTTS') || p.startsWith('GG')) return 'BTTS'
  if (p.match(/^[+-]?\d+(?:\.\d+)?\s*(1|X|2)$/)) return 'HCP'
  return 'OTHER'
}

function hashDispersion(home, away) {
  let h = 0
  if (home) for (let i = 0; i < home.length; i++) h = ((h << 5) - h + home.charCodeAt(i)) | 0
  let a = 0
  if (away) for (let i = 0; i < away.length; i++) a = ((a << 5) - a + away.charCodeAt(i)) | 0
  return ((h ^ a) % 140) / 1000 - 0.07
}

function oldDeriveXgFromOdds(m) {
  const oh = parseFloat(m.odds_home) || 2.0
  const ox = parseFloat(m.odds_draw) || 3.0
  const oa = parseFloat(m.odds_away) || 2.0
  const p_h = 1 / oh
  const p_x = 1 / ox
  const p_a = 1 / oa
  const sum = p_h + p_x + p_a
  const nh = p_h / sum
  const na = p_a / sum
  return { h: Math.max(0.5, nh * 3.0), a: Math.max(0.5, na * 3.0) }
}

function runEngine(m, xgH, xgA, mode) {
  const disp = hashDispersion(m.homeTeam, m.awayTeam)
  let h = xgH
  let a = xgA
  if (mode === 'old') {
    const mult = m.insufficient_data ? 1 : 0.3
    h += disp * mult
    a -= disp * mult
  } else if (m.insufficient_data) {
    h += disp
    a -= disp
  }
  const mm = { ...m, insufficient_data: 0 }
  return QuantumQuantEngine.analyze(mm, Math.max(0.3, h), Math.max(0.3, a))
}

function normalizePick(pick) {
  const p = String(pick || '')
    .trim()
    .toUpperCase()
  if (p === 'YES') return 'BTTS YES'
  if (p === 'NO') return 'BTTS NO'
  if (p === 'BTTS') return 'BTTS YES'
  return p
}

function main() {
  const args = process.argv.slice(2)
  const limitIdx = args.indexOf('--limit')
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0
  const onlyOdds = args.includes('--onlyOdds')

  const db = new Database(ARCHIVE_DB, { readonly: true })
  let rows = db
    .prepare(
      `SELECT id, homeTeam, awayTeam, league, tournament_name, scoreHome, scoreAway,
              odds_home, odds_draw, odds_away, home_xg, away_xg
       FROM archive_matches
       WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL`
    )
    .all()
  db.close()

  if (onlyOdds)
    rows = rows.filter((r) => parseFloat(r.odds_home) > 0 && parseFloat(r.odds_away) > 0)
  if (limit > 0) rows = rows.slice(0, limit)

  const stats = {
    old: {
      main: { won: 0, total: 0 },
      ou: { won: 0, total: 0 },
      btts: { won: 0, total: 0 },
      byMarket: {},
    },
    new: {
      main: { won: 0, total: 0 },
      ou: { won: 0, total: 0 },
      btts: { won: 0, total: 0 },
      byMarket: {},
    },
    bttsNoPicks: { old: 0, new: 0 },
    sumOver25Prob: { old: 0, new: 0 },
    sumBttsProb: { old: 0, new: 0 },
    oddsMatches: 0,
    sampled: rows.length,
  }

  for (const r of rows) {
    const league = r.league || r.tournament_name || ''
    const hasOdds =
      parseFloat(r.odds_home) > 0 && parseFloat(r.odds_draw) > 0 && parseFloat(r.odds_away) > 0
    const m = {
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      league,
      odds_home: hasOdds ? parseFloat(r.odds_home) : undefined,
      odds_draw: hasOdds ? parseFloat(r.odds_draw) : undefined,
      odds_away: hasOdds ? parseFloat(r.odds_away) : undefined,
      insufficient_data: hasOdds ? 0 : 1,
    }
    if (hasOdds) stats.oddsMatches++

    const leagueBase = StatisticalEngine._getLeagueBaseXG(league)
    const oldXg = hasOdds ? oldDeriveXgFromOdds(m) : { h: leagueBase.h, a: leagueBase.a }
    const newXg = hasOdds
      ? StatisticalEngine.deriveXgFromOdds(m)
      : { h: leagueBase.h, a: leagueBase.a }

    const oldRes = runEngine(m, oldXg.h, oldXg.a, 'old')
    const newRes = runEngine(m, newXg.h, newXg.a, 'new')

    stats.sumOver25Prob.old += oldRes.probs.over25
    stats.sumOver25Prob.new += newRes.probs.over25
    stats.sumBttsProb.old += oldRes.probs.btts
    stats.sumBttsProb.new += newRes.probs.btts

    const sh = parseInt(r.scoreHome) || 0
    const sa = parseInt(r.scoreAway) || 0
    const bothScored = sh > 0 && sa > 0

    for (const mode of ['old', 'new']) {
      const res = mode === 'old' ? oldRes : newRes
      const s = stats[mode]

      const mainPick = normalizePick(res.main_pick)
      const mainResult = mainPick ? evaluatePrediction(mainPick, sh, sa) : null
      if (mainResult === 'WON' || mainResult === 'LOST') {
        s.main.total++
        if (mainResult === 'WON') s.main.won++
        const mkt = classifyMarket(mainPick)
        s.byMarket[mkt] = s.byMarket[mkt] || { won: 0, total: 0 }
        s.byMarket[mkt].total++
        if (mainResult === 'WON') s.byMarket[mkt].won++
      }

      const ouPick = (res.probs.over25 || 0) > 50 ? 'O2.5' : 'U2.5'
      const ouResult = evaluatePrediction(ouPick, sh, sa)
      if (ouResult === 'WON' || ouResult === 'LOST') {
        s.ou.total++
        if (ouResult === 'WON') s.ou.won++
      }

      const bttsPick = (res.probs.btts || 0) > 50 ? 'BTTS YES' : 'BTTS NO'
      if (bttsPick === 'BTTS NO') stats.bttsNoPicks[mode]++
      const bttsResult = evaluatePrediction(bttsPick, sh, sa)
      if (bttsResult === 'WON' || bttsResult === 'LOST') {
        s.btts.total++
        if (bttsResult === 'WON') s.btts.won++
      }
    }
  }

  const pct = (won, total) => (total ? ((won / total) * 100).toFixed(1) + '%' : '-')

  console.log(`\n=== BACKTEST PRONOS (avant P2 vs après P2) ===`)
  console.log(
    `Échantillon : ${stats.sampled} matchs (${stats.oddsMatches} avec cotes 1X2) — source ${ARCHIVE_DB}`
  )
  console.log(`\n--- MAIN PICK (le pick affiché, évalué vs score réel) ---`)
  console.log(
    `  AVANT : ${stats.old.main.won}/${stats.old.main.total} (${pct(stats.old.main.won, stats.old.main.total)})`
  )
  console.log(
    `  APRÈS : ${stats.new.main.won}/${stats.new.main.total} (${pct(stats.new.main.won, stats.new.main.total)})`
  )

  console.log(`\n--- O/U 2.5 implicite (prob > 50% → Over, sinon Under) ---`)
  console.log(
    `  AVANT : ${stats.old.ou.won}/${stats.old.ou.total} (${pct(stats.old.ou.won, stats.old.ou.total)})`
  )
  console.log(
    `  APRÈS : ${stats.new.ou.won}/${stats.new.ou.total} (${pct(stats.new.ou.won, stats.new.ou.total)})`
  )

  console.log(`\n--- BTTS implicite (prob > 50% → YES, sinon NO) ---`)
  console.log(
    `  AVANT : ${stats.old.btts.won}/${stats.old.btts.total} (${pct(stats.old.btts.won, stats.old.btts.total)}) — picks NO: ${stats.bttsNoPicks.old}`
  )
  console.log(
    `  APRÈS : ${stats.new.btts.won}/${stats.new.btts.total} (${pct(stats.new.btts.won, stats.new.btts.total)}) — picks NO: ${stats.bttsNoPicks.new}`
  )

  console.log(`\n--- MAIN PICK par marché ---`)
  const markets = new Set([...Object.keys(stats.old.byMarket), ...Object.keys(stats.new.byMarket)])
  for (const mk of [...markets].sort()) {
    const o = stats.old.byMarket[mk]
    const n = stats.new.byMarket[mk]
    console.log(
      `  ${mk.padEnd(6)} AVANT ${pct(o?.won, o?.total).padStart(6)} (${o?.total || 0}) | APRÈS ${pct(n?.won, n?.total).padStart(6)} (${n?.total || 0})`
    )
  }

  console.log(`\n--- Probabilités moyennes (évite le biais "BTTS NON partout") ---`)
  console.log(
    `  BTTS YES moyen : AVANT ${(stats.sumBttsProb.old / stats.sampled).toFixed(1)}% | APRÈS ${(stats.sumBttsProb.new / stats.sampled).toFixed(1)}%`
  )
  console.log(
    `  Over 2.5 moyen : AVANT ${(stats.sumOver25Prob.old / stats.sampled).toFixed(1)}% | APRÈS ${(stats.sumOver25Prob.new / stats.sampled).toFixed(1)}%`
  )
  console.log('')
  process.exit(0)
}

main()
