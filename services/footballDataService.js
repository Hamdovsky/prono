/**
 * footballDataService.js — Récupération directe (Node) des cotes football-data.co.uk.
 *
 * P1-2026-08-29 audit: source 100% gratuite, pas de clé API, pas de rate limit
 * strict (CSV publics). Télécharge https://www.football-data.co.uk/fixtures.csv
 * à la demande, parse en mémoire, matche par (date, home, away) après
 * normalisation des noms d'équipe.
 *
 * Utilisé par dataFusionService comme source primaire (priority 1) pour les
 * matchs futurs — complémentaire du CSV local rafraîchi par data_pipeline
 * (07:00 daily) qui peut être stale.
 */
const axios = require('axios')
const logger = require('../core/logger')
const path = require('path')
const fs = require('fs')

const FIXTURES_URL = 'https://www.football-data.co.uk/fixtures.csv'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 min entre deux téléchargements
const REQUEST_TIMEOUT_MS = 15000

// Mapping league_code (CSV) -> nom lisible
const LEAGUE_NAME_MAP = {
  E0: 'Premier League',
  E1: 'Championship',
  D1: 'Bundesliga',
  D2: '2. Bundesliga',
  SP1: 'LaLiga',
  SP2: 'LaLiga 2',
  I1: 'Serie A',
  I2: 'Serie B',
  F1: 'Ligue 1',
  F2: 'Ligue 2',
  N1: 'Eredivisie',
  B1: 'Belgian Pro League',
  P1: 'Primeira Liga',
  G1: 'Super League Greece',
  T1: 'Süper Lig',
}

class FootballDataService {
  constructor() {
    this._cache = null // Map<key, entry>
    this._fetchedAt = 0
    this._fetching = null
    this._enabled = process.env.DISABLE_FOOTBALLDATA !== 'true'
    this._errors = 0
    this._cooldownUntil = 0
  }

  isAvailable() {
    if (!this._enabled) return false
    if (this._errors >= 3 && Date.now() < this._cooldownUntil) return false
    return true
  }

  _stripAccents(s) {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  }

  _normalizeTeamName(name) {
    let s = this._stripAccents(String(name || '').toLowerCase())
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    // Normalise les abréviations courantes de football-data.co.uk
    s = s
      .replace(/\bnott ?m?\b/g, 'nottingham')
      .replace(/\bnott ?\'?m\b/g, 'nottingham')
      .replace(/\bsp ?b\b/g, 'saint')
      .replace(/\bman ?utd\b/g, 'manchester united')
      .replace(/\bman ?city\b/g, 'manchester city')
      .replace(/\bmb\b/g, 'borussia')
      .replace(/\bm gladbach\b/g, 'monchengladbach')
      .replace(/\binter\b/g, 'internazionale')
    return s
  }

  _matchKey(date, home, away) {
    return `${date}|${this._normalizeTeamName(home)}|${this._normalizeTeamName(away)}`
  }

  _parseCsvLine(line) {
    const out = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"'
            i++
          } else inQ = false
        } else cur += ch
      } else if (ch === '"') inQ = true
      else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else cur += ch
    }
    out.push(cur)
    return out
  }

  _parseDateUK(s) {
    // DD/MM/YYYY
    if (!s) return null
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (!m) return null
    return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`
  }

  async _ensureCache() {
    if (this._cache && Date.now() - this._fetchedAt < CACHE_TTL_MS) return this._cache
    if (this._fetching) return this._fetching

    this._fetching = (async () => {
      try {
        logger.info(`[FOOTBALLDATA] Downloading ${FIXTURES_URL} ...`)
        const resp = await axios.get(FIXTURES_URL, {
          timeout: REQUEST_TIMEOUT_MS,
          responseType: 'text',
          headers: { 'User-Agent': 'Mozilla/5.0 (Stitch-Odds)' },
        })
        if (!resp.data || typeof resp.data !== 'string') {
          throw new Error('empty response')
        }
        const idx = this._buildIndex(resp.data)
        this._cache = idx
        this._fetchedAt = Date.now()
        this._errors = 0
        logger.info(`[FOOTBALLDATA] Loaded ${idx.size} fixtures`)
        return idx
      } catch (e) {
        this._errors++
        if (this._errors >= 3) this._cooldownUntil = Date.now() + 10 * 60 * 1000
        logger.warn(`[FOOTBALLDATA] Download failed (${this._errors}/3): ${e.message}`)
        return this._cache || new Map()
      } finally {
        this._fetching = null
      }
    })()
    return this._fetching
  }

  _buildIndex(text) {
    const out = new Map()
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length < 2) return out
    const header = this._parseCsvLine(lines[0]).map((c) => c.trim())
    const colIdx = (name) => header.indexOf(name)
    const iDiv = colIdx('Div')
    const iDate = colIdx('Date')
    const iTime = colIdx('Time')
    const iHome = colIdx('HomeTeam')
    const iAway = colIdx('AwayTeam')

    if (iDate < 0 || iHome < 0 || iAway < 0) {
      logger.warn(`[FOOTBALLDATA] Missing required columns in CSV header`)
      return out
    }

    // cotes 1X2 : prendre la 1ère dispo parmi B365, BFd, Pinnacle (PS), BW, Avg
    const oneX2Cols = ['B365H', 'B365D', 'B365A', 'BFdH', 'BFdD', 'BFdA', 'PSH', 'PSD', 'PSA', 'BWH', 'BWD', 'BWA', 'AvgH', 'AvgD', 'AvgA']
    const ouCols = ['B365>2.5', 'B365<2.5', 'P>2.5', 'P<2.5', 'Avg>2.5', 'Avg<2.5']
    const idx1X2 = ['B365H', 'B365D', 'B365A', 'BFdH', 'BFdD', 'BFdA', 'PSH', 'PSD', 'PSA', 'BWH', 'BWD', 'BWA', 'AvgH', 'AvgD', 'AvgA'].map(colIdx)
    const idxOU = ['B365>2.5', 'B365<2.5', 'P>2.5', 'P<2.5', 'Avg>2.5', 'Avg<2.5'].map(colIdx)

    for (let li = 1; li < lines.length; li++) {
      const cells = this._parseCsvLine(lines[li])
      const div = (cells[iDiv] || '').trim()
      const dateRaw = (cells[iDate] || '').trim()
      const time = (cells[iTime] || '').trim()
      const home = (cells[iHome] || '').trim()
      const away = (cells[iAway] || '').trim()
      if (!dateRaw || !home || !away) continue
      const date = this._parseDateUK(dateRaw)
      if (!date) continue
      const league = LEAGUE_NAME_MAP[div] || div

      const num = (v) => {
        const f = parseFloat(v)
        return Number.isFinite(f) && f > 1 ? f : null
      }

      // pick first available 1X2 triple
      let h = null, d = null, a = null
      for (let i = 0; i + 2 < idx1X2.length; i += 3) {
        h = num(cells[idx1X2[i]])
        d = num(cells[idx1X2[i + 1]])
        a = num(cells[idx1X2[i + 2]])
        if (h && d && a) break
        h = d = a = null
      }
      // OU 2.5
      let o = null, u = null
      for (let i = 0; i + 1 < idxOU.length; i += 2) {
        o = num(cells[idxOU[i]])
        u = num(cells[idxOU[i + 1]])
        if (o && u) break
        o = u = null
      }

      const entry = { league, date, time, homeTeam: home, awayTeam: away }
      if (h) entry.home = h
      if (d) entry.draw = d
      if (a) entry.away = a
      if (o) entry.over25 = o
      if (u) entry.under25 = u

      if (!entry.home && !entry.over25) continue
      const k1 = this._matchKey(date, home, away)
      if (!out.has(k1)) out.set(k1, entry)
      const k2 = this._matchKey(date, away, home)
      if (!out.has(k2)) out.set(k2, entry)
    }
    return out
  }

  async fetchOddsForMatch(match) {
    if (!this.isAvailable()) return null
    if (!match) return null
    const ts = parseInt(match.startTimestamp)
    if (!ts) return null
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    const home = match.homeTeam || match.home_team
    const away = match.awayTeam || match.away_team
    if (!home || !away) return null
    const cache = await this._ensureCache()
    if (!cache || cache.size === 0) return null
    const k = this._matchKey(date, home, away)
    const entry = cache.get(k)
    if (!entry) return { _odds_no_data: true }
    if (!entry.home && !entry.over25) return { _odds_no_data: true }
    return {
      home: entry.home || null,
      draw: entry.draw || null,
      away: entry.away || null,
      over25: entry.over25 || null,
      under25: entry.under25 || null,
      btts_yes: null,
      btts_no: null,
      source: 'football_data_live',
    }
  }

  getStats() {
    return {
      name: 'football_data_live',
      enabled: this._enabled,
      available: this.isAvailable(),
      errors: this._errors,
      cacheSize: this._cache ? this._cache.size : 0,
      cacheAge: this._fetchedAt > 0 ? Math.round((Date.now() - this._fetchedAt) / 1000) : null,
      url: FIXTURES_URL,
    }
  }
}

module.exports = new FootballDataService()
