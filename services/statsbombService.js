/**
 * StatsBomb open-data (github.com/statsbomb/open-data) — same underlying xG
 * source that fbref publishes, but served via plain GitHub raw (NO Cloudflare),
 * so it works from Render. Data is HISTORICAL/partial, so it is used only to
 * derive per-team expected goals (attack/defense xG) to feed the Poisson engine —
 * never as bookmaker odds. Falls back gracefully when data is missing.
 */

const axios = require('axios')
const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

const BASE = 'https://raw.githubusercontent.com/statsbomb/open-data/master/data'
const CACHE_TTL = 12 * 60 * 60 * 1000 // 12h — data is static historical, long cache is fine

// Preferred (competition_name) -> statbomb competition_id, with latest season ids
// we try to build team-xG from. Only the most recent available season is used.
const LEAGUES = {
  PL: { name: 'Premier League', compId: 2 },
  LA_LIGA: { name: 'La Liga', compId: 11 },
  SERIE_A: { name: 'Serie A', compId: 12 },
  BUNDESLIGA: { name: '1. Bundesliga', compId: 9 },
  LIGUE_1: { name: 'Ligue 1', compId: 7 },
  EREDIVISIE: { name: 'Eredivisie', compId: 14 },
  MLS: { name: 'Major League Soccer', compId: 44 },
}

const _competitionsCache = { ts: 0, data: null }

class StatsbombService {
  constructor() {
    this.enabled = true
    // { 'leagueCode': { for: Map(team->sum), against: Map, matches: Map, ts } }
    this._teamXgCache = {}
    this._seasonCountCache = {}
    this._persistPath = process.cwd() + '/data/statsbomb_team_xg.json'
  }

  isAvailable() {
    return this.enabled
  }

  async _loadCompetitions() {
    if (_competitionsCache.data && Date.now() - _competitionsCache.ts < CACHE_TTL) {
      return _competitionsCache.data
    }
    const r = await axios.get(`${BASE}/competitions.json`, { timeout: 20000 })
    _competitionsCache.data = r.data
    _competitionsCache.ts = Date.now()
    return r.data
  }

  // Resolve the best season (most match data, latest preferred) for a league.
  // season_id is NOT reliably chronological, so we fetch the match-count per
  // candidate and pick the one with the most matches (ties → most recent id).
  async _latestSeason(leagueCode) {
    const cfg = LEAGUES[leagueCode]
    if (!cfg) return null
    const comps = await this._loadCompetitions()
    const seasons = comps.filter(
      (c) => c.competition_id === cfg.compId && c.competition_name === cfg.name && c.match_available
    )
    if (!seasons.length) return null
    // Probe a bounded set of candidate seasons' match files and score them.
    const candidates = seasons.slice(0, 8) // most recent season_ids first is fine as a base
    let best = null
    for (const s of candidates) {
      let count = 0
      try {
        const url = `${BASE}/matches/${cfg.compId}/${s.season_id}.json`
        const mr = await axios.get(url, { timeout: 20000 })
        count = mr.data ? mr.data.length : 0
        if (this._seasonCountCache) this._seasonCountCache[`${cfg.compId}:${s.season_id}`] = count
      } catch (_) {}
      if (count > (best ? best.count : 0)) {
        best = { competition_id: cfg.compId, season_id: s.season_id, count }
      }
    }
    return best ? { competition_id: best.competition_id, season_id: best.season_id } : null
  }

  _sumMap(map, key, val) {
    map.set(key, (map.get(key) || 0) + val)
  }

  // Fetch all events for a match, aggregate shots xG per team. Returns
  // { homeTeam, awayTeam, homeXgFor, awayXgFor, homeXgAgainst, awayXgAgainst }.
  async _aggregateMatch(matchId, homeName, awayName, attempts = 3) {
    let lastErr
    for (let a = 0; a < attempts; a++) {
      if (a > 0) await new Promise((r) => setTimeout(r, 800 * a))
      try {
        const ev = await axios.get(`${BASE}/events/${matchId}.json`, { timeout: 25000 })
        const events = ev.data
        let homeFor = 0
        let awayFor = 0
        for (const e of events) {
          if (
            e.type &&
            e.type.name === 'Shot' &&
            e.shot &&
            typeof e.shot.statsbomb_xg === 'number'
          ) {
            if (e.team && e.team.name === homeName) homeFor += e.shot.statsbomb_xg
            else if (e.team && e.team.name === awayName) awayFor += e.shot.statsbomb_xg
          }
        }
        return { homeTeam: homeName, awayTeam: awayName, homeFor, awayFor }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }

  // Load persisted team-xG table into memory to avoid recomputing at boot.
  _restore() {
    try {
      if (fs.existsSync(this._persistPath)) {
        const raw = JSON.parse(fs.readFileSync(this._persistPath, 'utf8'))
        if (raw && raw.leagues) {
          for (const [code, lg] of Object.entries(raw.leagues)) {
            this._teamXgCache[code] = {
              for: new Map(Object.entries(lg.for || {})),
              against: new Map(Object.entries(lg.against || {})),
              matches: new Map(Object.entries(lg.matches || {})),
              ts: lg.ts || Date.now(),
            }
          }
        }
      }
    } catch (e) {
      logger.warn(`[STATSBOMB] restore persist failed: ${e.message}`)
    }
  }

  _persist() {
    try {
      const out = { leagues: {} }
      for (const [code, c] of Object.entries(this._teamXgCache)) {
        if (!c) continue
        out.leagues[code] = {
          for: Object.fromEntries(c.for),
          against: Object.fromEntries(c.against),
          matches: Object.fromEntries(c.matches),
          ts: c.ts,
        }
      }
      fs.writeFileSync(this._persistPath, JSON.stringify(out))
    } catch (e) {
      logger.warn(`[STATSBOMB] persist failed: ${e.message}`)
    }
  }

  // Build the whole league team-xG table (xG for AND against per team) from the
  // most recent available season. Memory-safe: reads events match by match.
  // Serialized per league so concurrent getTeamXG(home)+getTeamXG(away) rebuild once.
  async buildLeague(leagueCode) {
    const cached = this._teamXgCache[leagueCode]
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached
    if (this._building && this._building[leagueCode]) {
      await this._building[leagueCode]
      return this._teamXgCache[leagueCode] || null
    }
    this._building = this._building || {}
    const p = (async () => {
      const season = await this._latestSeason(leagueCode)
      if (!season) return null
      const url = `${BASE}/matches/${season.competition_id}/${season.season_id}.json`
      const mr = await axios.get(url, { timeout: 25000 })
      const matches = mr.data
      if (!matches || !matches.length) return null
      const stats = { for: new Map(), against: new Map(), matches: new Map() }
      const CONCURRENCY = 4
      let idx = 0
      async function worker() {
        while (idx < matches.length) {
          const m = matches[idx++]
          const homeName = m.home_team && m.home_team.home_team_name
          const awayName = m.away_team && m.away_team.away_team_name
          if (!homeName || !awayName) continue
          let agg
          try {
            agg = await this._aggregateMatch(m.match_id, homeName, awayName)
          } catch (e) {
            continue // skip matches lacking events — don't fail the whole build
          }
          this._sumMap(stats.for, homeName, agg.homeFor)
          this._sumMap(stats.for, awayName, agg.awayFor)
          this._sumMap(stats.against, homeName, agg.awayFor)
          this._sumMap(stats.against, awayName, agg.homeFor)
          this._sumMap(stats.matches, homeName, 1)
          this._sumMap(stats.matches, awayName, 1)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, matches.length) }, () => worker.call(this))
      )
      this._teamXgCache[leagueCode] = { ...stats, ts: Date.now() }
      this._persist()
      logger.info(
        `[STATSBOMB] Built team-xG for ${leagueCode} from ${season.season_id} (${matches.length} matches)`
      )
      return this._teamXgCache[leagueCode]
    })()
    this._building[leagueCode] = p
    try {
      return await p
    } finally {
      delete this._building[leagueCode]
    }
  }

  _normalize(name) {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  _matchTeam(stats, teamName) {
    const q = this._normalize(teamName)
    if (!q) return null
    const keys = [...stats.for.keys()]
    // exact, then prefix-word, then substring
    for (const k of keys) {
      const n = this._normalize(k)
      if (n === q) return k
    }
    const words = q.split(' ')
    for (const k of keys) {
      const n = this._normalize(k)
      if (n.split(' ').slice(0, words.length).join(' ') === words.join(' ')) return k
    }
    for (const k of keys) {
      const n = this._normalize(k)
      if (n && n.length > 3 && n.includes(q)) return k
    }
    return null
  }

  // Per-team expected goals for & against, averaged per match. Returns null if
  // the requested league team isn't found. `league` may be a code (e.g. 'BUNDESLIGA')
  // or a free-form league name (e.g. 'Bundesliga') — both resolve via LEAGUES/_mapLeagueCode.
  async getTeamXG(teamName, league) {
    const code = LEAGUES[league] ? league : this._mapLeagueCode(league)
    if (!code) return null
    let stats = this._teamXgCache[code]
    if (!stats || Date.now() - stats.ts >= CACHE_TTL) {
      stats = await this.buildLeague(code)
    }
    if (!stats) return null
    const key = this._matchTeam(stats, teamName)
    if (!key) return null
    const matches = stats.matches.get(key) || 0
    if (!matches) return null
    return {
      team: key,
      xG: (stats.for.get(key) || 0) / matches,
      xGA: (stats.against.get(key) || 0) / matches,
      matches,
    }
  }

  // Attach per-team xG onto a match for the Poisson engine. Only fills when the
  // match already lacks both real home/away xG and fbref didn't fill them.
  async attachMatchXG(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return match
    if (parseFloat(match.home_xg) > 0.1 && parseFloat(match.away_xg) > 0.1) return match
    const code = this._mapLeagueCode(match.league || match.tournament)
    if (!code) return match
    try {
      const [h, a] = await Promise.all([
        this.getTeamXG(match.homeTeam, code),
        this.getTeamXG(match.awayTeam, code),
      ])
      if (h && h.xG && !(parseFloat(match.home_xg) > 0.1)) match.home_xg = h.xG
      if (a && a.xG && !(parseFloat(match.away_xg) > 0.1)) match.away_xg = a.xG
      if (h && a) match._xgSource = 'statsbomb'
    } catch (e) {
      logger.warn(`[STATSBOMB] attachMatchXG skip ${match.id || ''}: ${e.message}`)
    }
    return match
  }

  _mapLeagueCode(leagueName) {
    const l = String(leagueName || '').toLowerCase()
    if (!l) return null
    if (l.includes('premier league') || l.includes('england')) return 'PL'
    if (l.includes('la liga') || l.includes('laliga') || l.includes('spain')) return 'LA_LIGA'
    if (l.includes('serie a') && !l.includes('serie b')) return 'SERIE_A'
    if (l.includes('bundesliga') && !l.includes('2')) return 'BUNDESLIGA'
    if (l.includes('ligue 1') || l.includes('ligue one') || l.includes('france')) return 'LIGUE_1'
    if (l.includes('eredivisie') || l.includes('netherlands') || l.includes('holland'))
      return 'EREDIVISIE'
    if (l.includes('mls') || l.includes('major league soccer')) return 'MLS'
    return null
  }
}

module.exports = (() => {
  const svc = new StatsbombService()
  svc._restore() // charge le cache disque au boot → évite re-build au 1er cycle
  return svc
})()
