/**
 * oddsportalStatsExtractor.js — E48 (Chantier couverture cotes).
 *
 * Objectif : remplir odds_home/draw/away/over25/under25 + odds_source='oddsportal'
 * pour les matchs A VENIR des ligues OBSCURES (Serie D, Regionalliga, NM Cup,
 * Liga 2, ...) que BetExplorer/football-data NE couvrent PAS (cf. E42/E44/E47).
 *
 * Miroir de fotmobStatsExtractor.js :
 *   - idempotent (COALESCE) : ne recouvre JAMAIS une cote deja presente,
 *   - dry-run par defaut,
 *   - gate : cron #15c (ODDSPORTAL_ENABLED, defaut OFF).
 *
 * Difference : source locale (sous-process Playwright dans SofascoreScraping/) au
 * lieu d'un HTTP FotMob. Passage par services/oddsportalClient.js (aucune dep
 * Playwright cote serveur). Regroupement par (league,dateISO) -> 1 appel client
 * par groupe, puis matching local<->distant via core/fdJoin.js joinKey.
 */
const { normDate } = require('../core/fdJoin')
const { slugForLeague } = require('../config/oddsportalLeagues')
const { isRealBookmakerSource } = require('../core/oddsSource')
const logger = require('../core/logger')

const STATUSES = ['scheduled', 'upcoming', 'NOT_STARTED', 'NS']
const DEFAULT_HORIZON_DAYS = Number(process.env.ODDSPORTAL_HORIZON_DAYS || 3)
const DEFAULT_LEAGUE_MAX = Number(process.env.ODDSPORTAL_LEAGUE_MAX || 20)

const UPDATE_SQL = `
  UPDATE matches SET
    odds_home     = COALESCE(odds_home, ?),
    odds_draw     = COALESCE(odds_draw, ?),
    odds_away     = COALESCE(odds_away, ?),
    odds_over25   = COALESCE(odds_over25, ?),
    odds_under25  = COALESCE(odds_under25, ?),
    odds_source   = COALESCE(odds_source, ?),
    last_updated  = ?
  WHERE id = ?`

function _num(v) {
  const f = parseFloat(v)
  return Number.isFinite(f) && f > 1 ? f : null
}

function _toTsMs(row) {
  const raw = row.startTimestamp
  if (raw == null || raw === 0) return 0
  if (typeof raw === 'string' && raw.includes('T')) return new Date(raw).getTime()
  const n = parseInt(raw)
  if (!Number.isFinite(n) || n === 0) return 0
  return n > 1e11 ? n : n * 1000
}

/**
 * Selectionne les matchs a venir des ligues OBSCURES (celles mappees dans
 * config/oddsportalLeagues) qui n'ont PAS encore de cote O/U ou 1X2.
 * @returns {Array<object>}
 */
function selectRows(db, { limit = 200, horizonDays = DEFAULT_HORIZON_DAYS } = {}) {
  const rows = db
    .prepare(
      `SELECT id, "homeTeam", "awayTeam", league, category_name, status,
              "startTimestamp", odds_home, odds_draw, odds_away,
              odds_over25, odds_under25, odds_source
       FROM matches
       WHERE status IN (${STATUSES.map(() => '?').join(',')})`
    )
    .all(...STATUSES)

  const now = Date.now()
  const end = now + horizonDays * 24 * 3600 * 1000
  const out = []
  for (const r of rows) {
    const ts = _toTsMs(r)
    if (!ts || ts > end) continue
    const slug = slugForLeague(r.league)
    if (!slug) continue
    const has1x2 = !!(_num(r.odds_home) && _num(r.odds_draw) && _num(r.odds_away))
    const hasOu = !!(_num(r.odds_over25) && _num(r.odds_under25))
    if (has1x2 && hasOu) continue
    if (isRealBookmakerSource(r.odds_source)) continue
    out.push({ ...r, _slug: slug, _date: _normDateLike(r.startTimestamp) })
  }
  out.sort((a, b) => _toTsMs(a) - _toTsMs(b))
  return out.slice(0, limit)
}

function _normDateLike(raw) {
  const ms = _toTsMs({ startTimestamp: raw })
  if (ms) return new Date(ms).toISOString().slice(0, 10)
  return normDate(raw)
}

/**
 * @param {object} db better-sqlite3
 * @param {{limit?:number, write?:boolean, horizonDays?:number, leagueMax?:number, log?:object, client?:object}} opts
 */
async function processScheduledMatches(db, opts = {}) {
  const {
    limit = 200,
    write = false,
    horizonDays = DEFAULT_HORIZON_DAYS,
    leagueMax = DEFAULT_LEAGUE_MAX,
    log = null,
    client = null,
  } = opts
  const lg = log || logger
  const cli = client || require('./oddsportalClient')
  const t0 = Date.now()

  const rows = selectRows(db, { limit, horizonDays })
  const stats = {
    scanned: rows.length,
    leagueCalls: 0,
    matched: 0,
    written: 0,
    noOddsPublished: 0,
    skippedNoMatch: 0,
    errors: 0,
    avgLatencyMs: 0,
    dryRun: !write,
  }
  if (rows.length === 0) {
    lg.info('[ODDSPORTAL] Rien a traiter (aucun match obscur sans cotes sur l horizon).')
    stats.ms = Date.now() - t0
    return stats
  }

  const groups = new Map()
  for (const r of rows) {
    const k = r._slug
    const arr = groups.get(k) || []
    arr.push(r)
    groups.set(k, arr)
  }

  const latencies = []
  const upd = db.prepare(UPDATE_SQL)
  const slugs = [...groups.keys()].slice(0, Math.max(1, leagueMax))

  for (const slug of slugs) {
    const group = groups.get(slug)
    let res = null
    try {
      const t = Date.now()
      res = await cli.fetchLeagueOdds(slug)
      latencies.push(Date.now() - t)
      stats.leagueCalls++
    } catch (e) {
      stats.errors++
      lg.warn(`[ODDSPORTAL] ${slug} ko: ${e.message}`)
      continue
    }
    if (!res || !Array.isArray(res.matches)) {
      stats.errors++
      lg.warn(`[ODDSPORTAL] ${slug} reponse invalide: ${(res && res.error) || 'no matches'}`)
      continue
    }
    if (res.noOddsPublished) stats.noOddsPublished += res.noOddsPublished
    if (res.errors) stats.errors += res.errors

    const remote = new Map()
    for (const m of res.matches) remote.set(_normLabel(m.label), m)

    for (const r of group) {
      const key = _normLabel(`${r.homeTeam} - ${r.awayTeam}`)
      let hit = remote.get(key)
      if (!hit) {
        hit = _fuzzyLookup(remote, r.homeTeam, r.awayTeam)
      }
      if (!hit) { stats.skippedNoMatch++; continue }
      const h = _num(hit.odds_home)
      const d = _num(hit.odds_draw)
      const a = _num(hit.odds_away)
      const o = _num(hit.odds_over25)
      const u = _num(hit.odds_under25)
      if (!h && !o) { stats.noOddsPublished++; continue }
      stats.matched++
      if (write) {
        try {
          upd.run(h, d, a, o, u, 'oddsportal', Date.now(), String(r.id))
          stats.written++
        } catch (e) {
          stats.errors++
          lg.warn(`[ODDSPORTAL] write ${r.id} ko: ${e.message}`)
        }
      }
    }
  }

  stats.avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
  stats.ms = Date.now() - t0
  lg.info(
    `[ODDSPORTAL] ${write ? 'WRITE' : 'DRY-RUN'} scanned=${stats.scanned} leagues=${stats.leagueCalls} matched=${stats.matched} written=${stats.written} noOdds=${stats.noOddsPublished} noMatch=${stats.skippedNoMatch} err=${stats.errors} avgLatency=${stats.avgLatencyMs}ms`
  )
  return stats
}

function _normLabel(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
}

function _fuzzyLookup(remote, homeTeam, awayTeam) {
  const hNorm = _normLabel(homeTeam).split(' ').filter(Boolean)
  const aNorm = _normLabel(awayTeam).split(' ').filter(Boolean)
  for (const m of remote.values()) {
    const label = _normLabel(m.label)
    const homeHit = hNorm.some((w) => w.length >= 4 && label.includes(w))
    const awayHit = aNorm.some((w) => w.length >= 4 && label.includes(w))
    if (homeHit && awayHit) return m
  }
  return null
}

module.exports = {
  processScheduledMatches,
  selectRows,
  UPDATE_SQL,
  DEFAULT_HORIZON_DAYS,
}
