/**
 * topPicksService.js — Persists daily top-picks and settles them against real results.
 *
 * Pipeline:
 *  1. syncDailyPicks()   — read data/daily_predictions.json → upsert into top_picks
 *  2. linkPicksToMatches() — match each pending pick to a finished match (teams + date window)
 *  3. settlePendingPicks() — evaluate pick (1/X/2) against the real score → WON/LOST
 *  4. getTopPicksAccuracy() — accuracy / ROI by cohort (top_confidence, top_value, all)
 */

const path = require('path')
const fs = require('fs')
const db = require('../core/database')
const logger = require('../core/logger')

const DAILY_PREDICTIONS_PATH = path.join(__dirname, '..', 'data', 'daily_predictions.json')
const WINDOW_DAYS = 3

// ── Team matching helpers ────────────────────────────────────────

function simplifyTeam(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
}

function stripNoise(words) {
  return words.filter(
    (w) =>
      !/^(fc|ac|cf|sc|rs|rj|sp|mg|pr|ba|pe|go|mt|ms|pa|rn|ce|pi|ma|ap|ro|to|se|al|pb|df|es)$/i.test(
        w
      ) && w.length > 1
  )
}

function teamWords(name) {
  return stripNoise(simplifyTeam(name).split(/\s+/).filter(Boolean))
}

function teamsMatch(pickHome, pickAway, matchHome, matchAway) {
  const ph = teamWords(pickHome)
  const pa = teamWords(pickAway)
  const mh = teamWords(matchHome)
  const ma = teamWords(matchAway)
  if (!ph.length || !pa.length || !mh.length || !ma.length) return false
  const allMatch = (pWords, dWords) =>
    pWords.every((pw) =>
      dWords.some((dw) => dw.includes(pw) || (pw.length > 2 && dw.length >= 3 && pw.includes(dw)))
    )
  return allMatch(ph, mh) && allMatch(pa, ma)
}

// ── Helpers ─────────────────────────────────────────────────────

function pickId(date, home, away) {
  const clean = (s) =>
    (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
  return `${date}_${clean(home)}_${clean(away)}`
}

function dateWindowSec(pickDate) {
  const base = new Date(`${pickDate}T00:00:00Z`).getTime() / 1000
  return { min: base - WINDOW_DAYS * 86400, max: base + (WINDOW_DAYS + 1) * 86400 }
}

function getPredictionSources(pick, topConfKeys, topValueKeys) {
  const key = pickId(pick.date, pick.home, pick.away)
  const inConf = topConfKeys.has(key)
  const inVal = topValueKeys.has(key)
  if (inConf && inVal) return 'both'
  if (inConf) return 'top_confidence'
  if (inVal) return 'top_value'
  return 'all'
}

function statusIsFinished(status) {
  return ['FT', 'finished', 'Finished', 'Ended'].includes((status || '').trim())
}

// ── Step 1: Sync daily picks ────────────────────────────────────

function syncDailyPicks() {
  if (!fs.existsSync(DAILY_PREDICTIONS_PATH)) {
    logger.info('[TOP-PICKS] No daily_predictions.json found — skipping sync')
    return { synced: 0, skipped: 0 }
  }

  let payload
  try {
    payload = JSON.parse(fs.readFileSync(DAILY_PREDICTIONS_PATH, 'utf-8'))
  } catch (e) {
    logger.error(`[TOP-PICKS] Failed to parse daily_predictions.json: ${e.message}`)
    return { synced: 0, skipped: 0 }
  }

  const allPicks = Array.isArray(payload.all) ? payload.all : []
  const topConfKeys = new Set(
    (payload.top_confidence || []).map((p) => pickId(p.date, p.home, p.away))
  )
  const topValueKeys = new Set((payload.top_value || []).map((p) => pickId(p.date, p.home, p.away)))
  const now = Date.now()

  let synced = 0
  let skipped = 0
  for (const p of allPicks) {
    if (!p.home || !p.away || !p.date || !p.prediction) continue
    const id = pickId(p.date, p.home, p.away)
    const source = getPredictionSources(p, topConfKeys, topValueKeys)

    try {
      // Never overwrite an already-settled pick
      const updated = db
        .prepare(
          `
          INSERT INTO top_picks (
            id, pick_date, home_team, away_team, league, prediction, confidence,
            home_prob, draw_prob, away_prob, odds_home, odds_draw, odds_away,
            odds_source, ev, kelly, has_real_odds, models, source, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            prediction = excluded.prediction,
            confidence = excluded.confidence,
            home_prob = excluded.home_prob,
            draw_prob = excluded.draw_prob,
            away_prob = excluded.away_prob,
            odds_home = excluded.odds_home,
            odds_draw = excluded.odds_draw,
            odds_away = excluded.odds_away,
            odds_source = excluded.odds_source,
            ev = excluded.ev,
            kelly = excluded.kelly,
            has_real_odds = excluded.has_real_odds,
            models = excluded.models,
            source = CASE WHEN top_picks.status = 'SETTLED' THEN top_picks.source ELSE excluded.source END
          WHERE top_picks.status <> 'SETTLED'
          `
        )
        .run(
          id,
          p.date,
          p.home,
          p.away,
          p.league || '',
          p.prediction,
          p.confidence ?? null,
          p.home_prob ?? null,
          p.draw_prob ?? null,
          p.away_prob ?? null,
          p.odds_home ?? null,
          p.odds_draw ?? null,
          p.odds_away ?? null,
          p.odds_source || 'default',
          p.ev ?? null,
          p.kelly ?? null,
          p.has_real_odds ? 1 : 0,
          p.models || '',
          source,
          now
        )
      synced += updated.changes
    } catch (e) {
      skipped++
      logger.warn(`[TOP-PICKS] Upsert failed for ${id}: ${e.message}`)
    }
  }

  logger.info(`[TOP-PICKS] Synced ${synced} picks (${skipped} errors)`)
  return { synced, skipped }
}

// ── Step 2: Link picks to finished matches ──────────────────────

function _findMatchForPick(pick) {
  const win = dateWindowSec(pick.pick_date || pick.date)
  const where = `WHERE status IN ('FT', 'finished', 'Finished', 'Ended')
     AND "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL
     AND ("startTimestamp" IS NOT NULL OR timestamp IS NOT NULL)
     AND (
       ("startTimestamp" BETWEEN ? AND ?)
       OR (timestamp BETWEEN ? AND ?)
     )`

  const rows = db
    .prepare(
      `SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", status FROM matches ${where} ORDER BY "startTimestamp" DESC LIMIT 200`
    )
    .all(
      win.min,
      win.max,
      new Date(win.min * 1000).toISOString(),
      new Date(win.max * 1000).toISOString()
    )
  for (const r of rows) {
    if (teamsMatch(pick.home_team, pick.away_team, r.homeTeam, r.awayTeam)) {
      return r
    }
  }

  // Fallback: archived matches (finished results kept after cleanup)
  try {
    const archived = db
      .prepare(
        `SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway" FROM historical_matches WHERE "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL`
      )
      .all()
    for (const r of archived) {
      if (teamsMatch(pick.home_team, pick.away_team, r.homeTeam, r.awayTeam)) return r
    }
  } catch (_) {}
  return null
}

function linkPicksToMatches() {
  const picks = db
    .prepare(
      `SELECT id, pick_date, home_team, away_team, league, prediction FROM top_picks WHERE status = 'PENDING' AND (match_id IS NULL OR match_id = '')`
    )
    .all()

  let linked = 0
  for (const pick of picks) {
    const match = _findMatchForPick(pick)
    if (!match) continue
    try {
      db.prepare(`UPDATE top_picks SET match_id = ? WHERE id = ?`).run(match.id, pick.id)
      linked++
    } catch (e) {
      logger.warn(`[TOP-PICKS] Link failed for ${pick.id}: ${e.message}`)
    }
  }
  if (linked > 0) logger.info(`[TOP-PICKS] Linked ${linked} picks to finished matches`)
  return { linked }
}

// ── Step 3: Settle pending picks ────────────────────────────────

function settlePendingPicks() {
  const picks = db
    .prepare(
      `SELECT id, pick_date, home_team, away_team, league, prediction, confidence, odds_home, odds_draw, odds_away, match_id, source FROM top_picks WHERE status = 'PENDING' AND match_id IS NOT NULL AND match_id != ''`
    )
    .all()

  let settled = 0
  for (const pick of picks) {
    let match = null
    try {
      match = db
        .prepare(`SELECT "scoreHome", "scoreAway", status FROM matches WHERE id = ?`)
        .get(pick.match_id)
    } catch (_) {}
    if (
      !match ||
      !statusIsFinished(match.status) ||
      match.scoreHome == null ||
      match.scoreAway == null
    ) {
      try {
        match = db
          .prepare(`SELECT "scoreHome", "scoreAway" FROM historical_matches WHERE id = ?`)
          .get(pick.match_id)
      } catch (_) {}
    }
    if (!match || match.scoreHome == null || match.scoreAway == null) continue

    const sh = parseInt(match.scoreHome) || 0
    const sa = parseInt(match.scoreAway) || 0
    const pred = (pick.prediction || '').toUpperCase()

    let result = null
    if (pred === '1') result = sh > sa ? 'WON' : 'LOST'
    else if (pred === 'X') result = sh === sa ? 'WON' : 'LOST'
    else if (pred === '2') result = sh < sa ? 'WON' : 'LOST'
    else result = null

    if (!result) continue

    try {
      db.prepare(
        `UPDATE top_picks SET status = 'SETTLED', result = ?, score = ?, settled_at = ? WHERE id = ?`
      ).run(result, `${sh}-${sa}`, Date.now(), pick.id)
      settled++
      logger.info(
        `[TOP-PICKS] Settled ${pick.home_team} ${sh}-${sa} ${pick.away_team} → ${result} (${pick.prediction})`
      )
    } catch (e) {
      logger.warn(`[TOP-PICKS] Settle failed for ${pick.id}: ${e.message}`)
    }
  }
  if (settled > 0) logger.info(`[TOP-PICKS] Settled ${settled} picks`)
  return { settled }
}

// ── Step 4: Accuracy analytics ──────────────────────────────────

function getTopPicksAccuracy() {
  const rows = db
    .prepare(
      `SELECT * FROM top_picks WHERE status = 'SETTLED' AND result IN ('WON', 'LOST') ORDER BY pick_date ASC`
    )
    .all()

  const total = rows.length
  const won = rows.filter((r) => r.result === 'WON').length
  const lost = rows.filter((r) => r.result === 'LOST').length
  const winRate = total > 0 ? Math.round((won / total) * 1000) / 10 : 0

  // Flat-stake ROI using recorded odds (1 unit on the picked side)
  let stake = 0
  let returns = 0
  for (const r of rows) {
    const odds =
      r.prediction === '1' ? r.odds_home : r.prediction === 'X' ? r.odds_draw : r.odds_away
    if (odds && odds > 1) {
      stake += 1
      returns += r.result === 'WON' ? odds : 0
    }
  }
  const roi = stake > 0 ? Math.round(((returns - stake) / stake) * 1000) / 10 : 0

  // By cohort
  const cohorts = ['top_confidence', 'top_value', 'both', 'all']
  const bySource = {}
  for (const c of cohorts) {
    const cRows = rows.filter((r) => r.source === c)
    const cTotal = cRows.length
    const cWon = cRows.filter((r) => r.result === 'WON').length
    bySource[c] = {
      total: cTotal,
      won: cWon,
      lost: cTotal - cWon,
      win_rate: cTotal > 0 ? Math.round((cWon / cTotal) * 1000) / 10 : 0,
    }
  }

  // By confidence bracket
  const brackets = ['50-60%', '60-70%', '70-80%', '80-90%', '90%+']
  const byConfidence = {}
  for (const b of brackets) {
    const [min, max] = [parseFloat(b), b === '90%+' ? 200 : parseFloat(b) + 10]
    const bRows = rows.filter((r) => {
      const conf = parseFloat(r.confidence) || 0
      return conf >= min && conf < max
    })
    const bTotal = bRows.length
    const bWon = bRows.filter((r) => r.result === 'WON').length
    byConfidence[b] = {
      total: bTotal,
      won: bWon,
      lost: bTotal - bWon,
      win_rate: bTotal > 0 ? Math.round((bWon / bTotal) * 1000) / 10 : 0,
    }
  }

  // Recent history
  const recent = rows
    .slice(-20)
    .reverse()
    .map((r) => ({
      date: r.pick_date,
      home: r.home_team,
      away: r.away_team,
      prediction: r.prediction,
      result: r.result,
      score: r.score,
      confidence: r.confidence,
      source: r.source,
    }))

  return {
    total_settled: total,
    won,
    lost,
    win_rate: winRate,
    roi_percent: roi,
    pending: (() => {
      try {
        return db.prepare(`SELECT COUNT(*) n FROM top_picks WHERE status = 'PENDING'`).get().n
      } catch (_) {
        return 0
      }
    })(),
    by_source: bySource,
    by_confidence: byConfidence,
    recent,
  }
}

// ── Entry point: sync + link + settle ───────────────────────────

function runScoringPipeline() {
  const sync = syncDailyPicks()
  const link = linkPicksToMatches()
  const settle = settlePendingPicks()
  return { sync, link, settle }
}

module.exports = {
  syncDailyPicks,
  linkPicksToMatches,
  settlePendingPicks,
  getTopPicksAccuracy,
  runScoringPipeline,
}
