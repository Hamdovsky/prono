/**
 * proPlanBankroll.js — Gestionnaire de bankroll "Plan Pro 1X2" (devise DT).
 *
 * Objectif : 100 DT → 400 DT (x4) avec une croissance maîtrisée et une
 * protection stricte du capital :
 *   - Staking gradué par paliers de bankroll (Quarter-Kelly plafonné au palier) ;
 *   - Exposition max par jour limitée ;
 *   - Stop-loss : bankroll <= 80 DT → pause de 7 jours (revue) ;
 *   - Objectif atteint (400 DT) → plus aucune mise (retrait recommandé) ;
 *   - Sous 85 DT → mode "reconstruction" (mise 1 %).
 *
 * Persistance : SQLite (tables pro_plan + pro_plan_bets) via le db de
 * l'application, injectable en mémoire pour les tests.
 */

const logger = require('../core/logger')

// ── Constantes du plan ───────────────────────────────────────────
const INITIAL_BANKROLL = 100.0
const TARGET_BANKROLL = 400.0
const STOP_LOSS_LEVEL = 80.0
const STOP_LOSS_PAUSE_DAYS = 7
const RECONSTRUCT_LEVEL = 85.0
const KELLY_FRAC = 0.25 // Quarter-Kelly
const CURRENCY = 'TND'

// Paliers par tranche de bankroll.
function tierFor(bankroll) {
  const b = Number(bankroll) || 0
  if (b >= TARGET_BANKROLL) return { label: 'target_reached', stakePct: 0.0, maxDailyExposure: 0.0 }
  if (b >= 250) return { label: 'accelerator', stakePct: 0.04, maxDailyExposure: 0.10 }
  if (b >= 150) return { label: 'growth', stakePct: 0.03, maxDailyExposure: 0.08 }
  if (b >= RECONSTRUCT_LEVEL) return { label: 'consolidation', stakePct: 0.02, maxDailyExposure: 0.06 }
  return { label: 'reconstruction', stakePct: 0.01, maxDailyExposure: 0.03 }
}

// ── Accès DB (injectable) ────────────────────────────────────────
let _db = null

function getDb() {
  if (_db) return _db
  try {
    _db = require('../core/database').db || null
  } catch {
    _db = null
  }
  return _db
}

// ── SQL ──────────────────────────────────────────────────────────
const CREATE_PLAN_SQL = `
  CREATE TABLE IF NOT EXISTS pro_plan (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    bankroll    REAL    DEFAULT 100.0,
    currency    TEXT    DEFAULT 'TND',
    target      REAL    DEFAULT 400.0,
    started_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
    paused_until TEXT
  )`

const CREATE_BETS_SQL = `
  CREATE TABLE IF NOT EXISTS pro_plan_bets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id    TEXT,
    home        TEXT,
    away        TEXT,
    league      TEXT,
    pick        TEXT,
    odds        REAL,
    prob        REAL,
    edge        REAL,
    stake_dt    REAL    DEFAULT 0,
    result      TEXT,
    pnl_dt      REAL    DEFAULT 0,
    settled_at  TEXT    DEFAULT CURRENT_TIMESTAMP
  )`

const CREATE_QUANT_PERF_SQL = `
  CREATE TABLE IF NOT EXISTS quant_performance (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id     TEXT,
    taken_odds   REAL,
    closing_odds REAL,
    clv          REAL,
    pnl          REAL,
    stake        REAL,
    ev_at_bet    REAL,
    timestamp    TEXT    DEFAULT CURRENT_TIMESTAMP
  )`

function init() {
  const db = getDb()
  if (!db) throw new Error('[PRO-PLAN] DB indisponible')
  db.prepare(CREATE_PLAN_SQL).run()
  db.prepare(CREATE_BETS_SQL).run()
  db.prepare(CREATE_QUANT_PERF_SQL).run()
  const row = db.prepare('SELECT id FROM pro_plan WHERE id = 1').get()
  if (!row) {
    db.prepare(
      'INSERT INTO pro_plan (id, bankroll, currency, target) VALUES (1, ?, ?, ?)'
    ).run(INITIAL_BANKROLL, CURRENCY, TARGET_BANKROLL)
  }
}

function getState() {
  const db = getDb()
  if (!db) return null
  init()
  const row = db.prepare('SELECT * FROM pro_plan WHERE id = 1').get()
  if (!row) return null
  const now = Date.now()
  const pausedTs = row.paused_until ? new Date(row.paused_until).getTime() : 0
  return {
    bankroll: Number(row.bankroll) || 0,
    currency: row.currency || CURRENCY,
    target: Number(row.target) || TARGET_BANKROLL,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    pausedUntil: row.paused_until || null,
    paused: !!(pausedTs && pausedTs > now),
  }
}

function getTier() {
  const st = getState()
  if (!st) return null
  return tierFor(st.bankroll)
}

/**
 * Mise recommandée (Quarter-Kelly plafonné au palier).
 * probPct en % (ex. 60 pour 60 %). Retourne { stakePct, stakeDt, kellyFull, capped, tier }.
 */
function recommendStake(probPct, odds, bankroll = null) {
  const b = bankroll != null ? Number(bankroll) : (getState()?.bankroll ?? INITIAL_BANKROLL)
  const tier = tierFor(b)
  const p = (Number(probPct) || 0) / 100
  const o = Number(odds) || 0
  if (p <= 0 || p >= 1 || o <= 1 || tier.stakePct <= 0) {
    return { stakePct: 0, stakeDt: 0, kellyFull: 0, capped: false, tier: tier.label }
  }
  const kellyFull = (p * o - 1) / (o - 1)
  const frac = kellyFull * KELLY_FRAC
  const stakePct = Math.min(Math.max(frac, 0), tier.stakePct)
  const stakeDt = Math.round(b * stakePct * 100) / 100
  return { stakePct, stakeDt, kellyFull, capped: frac > tier.stakePct, tier: tier.label }
}

/**
 * Cote de clôture d'un pick (dernière cote réelle connue dans odds_history).
 * Pick : '1' | 'X' | '2' | '1X' | 'X2' | '12'. Retourne null si indisponible.
 */
function closingOddsFor(db, matchId, pick) {
  if (!matchId || !pick) return null
  let row = null
  try {
    row = db
      .prepare(
        `SELECT odds_home, odds_draw, odds_away FROM odds_history
         WHERE match_id = ? AND odds_home > 0
         ORDER BY id DESC LIMIT 1`
      )
      .get(String(matchId))
  } catch {
    row = null
  }
  if (!row) return null
  const h = Number(row.odds_home) || 0
  const d = Number(row.odds_draw) || 0
  const a = Number(row.odds_away) || 0
  const pickMap = {
    '1': () => h,
    X: () => d,
    '2': () => a,
    '1X': () => h && d ? 1 / (1 / h + 1 / d) : 0,
    X2: () => d && a ? 1 / (1 / d + 1 / a) : 0,
    '12': () => h && a ? 1 / (1 / h + 1 / a) : 0,
  }
  const fn = pickMap[String(pick).toUpperCase().trim()]
  if (!fn) return null
  const closing = fn()
  return closing > 1 ? closing : null
}

/**
 * Traque la performance (CLV) d'un pari réglé dans quant_performance.
 * Échec silencieux : ne fait jamais échouer le règlement.
 */
function recordQuantPerformance({ matchId, pick, odds, stake, pnl, evAtBet }) {
  const db = getDb()
  if (!db) return
  try {
    const taken = Number(odds) || 0
    const closing = closingOddsFor(db, matchId, pick)
    if (taken <= 1 || !closing) return
    const clv = +(taken / closing - 1) * 100 // % (positif = bonne valeur prise)
    db.prepare(
      `INSERT INTO quant_performance (match_id, taken_odds, closing_odds, clv, pnl, stake, ev_at_bet)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      matchId || null,
      +taken.toFixed(2),
      +closing.toFixed(2),
      +clv.toFixed(2),
      pnl != null ? +pnl.toFixed(2) : null,
      stake != null ? +stake.toFixed(2) : null,
      evAtBet != null ? +evAtBet.toFixed(4) : null
    )
  } catch (e) {
    logger.warn(`[PRO-PLAN] CLV tracking skipped: ${e.message}`)
  }
}

/**
 * Enregistre le règlement d'un pick et met à jour la bankroll.
 * result : 'WON' | 'LOST' | 'PUSH'.
 */
function settleBet({ matchId, home, away, league, pick, odds, prob, edge, result }) {
  const db = getDb()
  if (!db) throw new Error('[PRO-PLAN] DB indisponible')
  init()
  const r = String(result || '').toUpperCase()
  if (!['WON', 'LOST', 'PUSH'].includes(r)) throw new Error(`result invalide: ${result}`)

  const st = getState()
  const rec = recommendStake(prob, odds, st.bankroll)
  let pnl = 0
  if (r === 'WON') pnl = rec.stakeDt * (odds - 1)
  else if (r === 'LOST') pnl = -rec.stakeDt

  const newBankroll = Math.round((st.bankroll + pnl) * 100) / 100
  let pausedUntil = null
  if (newBankroll <= STOP_LOSS_LEVEL) {
    pausedUntil = new Date(Date.now() + STOP_LOSS_PAUSE_DAYS * 24 * 3600 * 1000).toISOString()
  }

  db.prepare(
    `INSERT INTO pro_plan_bets
       (match_id, home, away, league, pick, odds, prob, edge, stake_dt, result, pnl_dt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(matchId || null, home || null, away || null, league || null, pick || null,
        odds || null, prob != null ? prob : null, edge != null ? edge : null,
        rec.stakeDt, r, pnl)

  db.prepare(
    'UPDATE pro_plan SET bankroll = ?, updated_at = CURRENT_TIMESTAMP, paused_until = ? WHERE id = 1'
  ).run(newBankroll, pausedUntil)

  recordQuantPerformance({
    matchId,
    pick,
    odds,
    stake: rec.stakeDt,
    pnl,
    evAtBet: prob != null ? (prob / 100) * (Number(odds) || 0) - 1 : null,
  })

  logger.info(
    `[PRO-PLAN] settle ${pick} @${odds} -> ${r} | stake=${rec.stakeDt} DT | pnl=${Math.round(pnl * 100) / 100} DT | bankroll=${newBankroll} DT`
  )

  return {
    bankroll: newBankroll,
    stakeDt: rec.stakeDt,
    pnl: Math.round(pnl * 100) / 100,
    paused: !!pausedUntil,
    pausedUntil,
    targetReached: newBankroll >= TARGET_BANKROLL,
    tier: rec.tier,
  }
}

function getHistory() {
  const db = getDb()
  if (!db) return []
  init()
  return db.prepare('SELECT * FROM pro_plan_bets ORDER BY id DESC').all()
}

function getSummary() {
  const st = getState()
  if (!st) return null
  const tier = tierFor(st.bankroll)
  const bets = getHistory()
  const wins = bets.filter((b) => b.result === 'WON').length
  const losses = bets.filter((b) => b.result === 'LOST').length
  const pushes = bets.filter((b) => b.result === 'PUSH').length
  const totalStaked = bets.reduce((s, b) => s + (Number(b.stake_dt) || 0), 0)
  const totalPnl = bets.reduce((s, b) => s + (Number(b.pnl_dt) || 0), 0)
  const progression = Math.max(
    0,
    Math.min(1, (st.bankroll - INITIAL_BANKROLL) / (TARGET_BANKROLL - INITIAL_BANKROLL))
  )
  return {
    state: st,
    tier,
    initial: INITIAL_BANKROLL,
    target: TARGET_BANKROLL,
    progression,
    remainingToTarget: Math.round((TARGET_BANKROLL - st.bankroll) * 100) / 100,
    stats: {
      bets: bets.length,
      wins,
      losses,
      pushes,
      totalStaked: Math.round(totalStaked * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      roi: totalStaked > 0 ? Math.round((totalPnl / totalStaked) * 10000) / 100 : null,
    },
    rules: {
      staking: 'Quarter-Kelly x0.25, plafonné par palier',
      tiers: [
        { range: '< 85 DT', label: 'reconstruction', pct: '1 %' },
        { range: '85-149 DT', label: 'consolidation', pct: '2 %' },
        { range: '150-249 DT', label: 'growth', pct: '3 %' },
        { range: '250-399 DT', label: 'accelerator', pct: '4 %' },
      ],
      maxPicksPerDay: 3,
      stopLoss: 'bankroll <= 80 DT -> pause 7 jours',
      targetRule: '400 DT atteint -> plus aucune mise (retrait de 300 DT recommandé)',
    },
  }
}

module.exports = {
  init,
  getState,
  getTier,
  recommendStake,
  settleBet,
  getHistory,
  getSummary,
  _internal: {
    INITIAL_BANKROLL,
    TARGET_BANKROLL,
    STOP_LOSS_LEVEL,
    RECONSTRUCT_LEVEL,
    __setDb: (db) => {
      _db = db
    },
    __resetForTest: () => {
      const db = getDb()
      if (!db) return
      db.prepare('DROP TABLE IF EXISTS pro_plan_bets').run()
      db.prepare('DROP TABLE IF EXISTS pro_plan').run()
      init()
    },
    __setBankroll: (v) => {
      const db = getDb()
      if (!db) return
      init()
      db.prepare(
        'UPDATE pro_plan SET bankroll = ?, updated_at = CURRENT_TIMESTAMP, paused_until = NULL WHERE id = 1'
      ).run(v)
    },
  },
}
