/**
 * UltimateScraperOrchestrator.js — Le système de scraping ultime 100% gratuit.
 *
 * P1-2026-08-29
 *
 * Chaque source scraping travaille indépendamment et en parallèle.
 * L'orchestrateur fusionne les résultats avec comparaison des cotes
 * pour choisir la meilleure valeur.
 *
 * Sources actives (toutes gratuites, zero API key) :
 *
 *  ODDS:
 *  ├─ football_data_live  (fixtures.csv, ~22 ligues, instantané, 10min cache)
 *  ├─ sofascore_api       (SofaAPI public, 12 marchés, no-key, 10min cache)
 *  ├─ sofascore_bypass    (curl_cffi Python, odds+injuries+lineups+stats)
 *  ├─ betexplorer_1x2    (curl_cffi, 1X2, ~2-4s/match)
 *  ├─ betexplorer_ou_btts (curl_cffi AJAX, O/U + BTTS)
 *  └─ jina_flashscore     (r.jina.ai fallback, odds comparison)
 *
 *  LIVE SCORES:
 *  ├─ livescore_api      (API publique, 62 ligues, instantané)
 *  └─ soccerway_jina     (résultats + historique)
 *
 *  INJURIES / ABSENCES:
 *  ├─ sofascore_bypass   (curl_cffi injuries)
 *  └─ sofascore_api      (SofaAPI public)
 *
 *  STATS:
 *  ├─ sofascore_bypass   (curl_cffi stats: HT score, corners)
 *  └─ sofascore_api      (xG, stats détaillées)
 */

const https = require('https')
const http = require('http')
const logger = require('../core/logger')

// ── Lazy-load des scrapers ────────────────────────────────────────────────────

let _fdLive = null
let _sofaOdds = null
let _sofaBypass = null
let _betexplorer = null
let _jina = null
let _liveScore = null
let _soccerwayJina = null

function getFootballDataLive() {
  if (_fdLive === null) { try { _fdLive = require('./footballDataService') } catch { _fdLive = null } }
  return _fdLive
}

function getSofascoreOdds() {
  if (_sofaOdds === null) { try { _sofaOdds = require('./sofascoreOddsService') } catch { _sofaOdds = null } }
  return _sofaOdds
}

function getSofascoreBypass() {
  if (_sofaBypass === null) {
    try { _sofaBypass = require('./scrapers/SofascoreBypass') } catch { _sofaBypass = null }
  }
  return _sofaBypass
}

function getBetExplorer() {
  if (_betexplorer === null) {
    try { _betexplorer = require('./scrapers/ScrapingBypassScraper') } catch { _betexplorer = null }
  }
  return _betexplorer
}

function getJina() {
  if (_jina === null) { try { _jina = require('./scrapers/JinaScraper') } catch { _jina = null } }
  return _jina
}

function getLiveScore() {
  if (_liveScore === null) {
    try { _liveScore = require('../config/sources/livescore') } catch { _liveScore = null }
  }
  return _liveScore
}

function getSoccerwayJina() {
  if (_soccerwayJina === null) { try { _soccerwayJina = require('./scrapers/JinaScraper') } catch { _soccerwayJina = null } }
  return _soccerwayJina
}

// ── Shared cache ──────────────────────────────────────────────────────────────

const CACHE = new Map()
const CACHE_TTL = 10 * 60 * 1000 // 10 min

function cacheGet(key) {
  const e = CACHE.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { CACHE.delete(key); return null }
  return e.data
}

function cacheSet(key, data) {
  CACHE.set(key, { ts: Date.now(), data })
}

function oddsKey(source, matchId, home, away) {
  return `${source}:${matchId || ''}:${(home || '').toLowerCase().trim()}:${(away || '').toLowerCase().trim()}`
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

const RATE = new Map()
const MIN_GAP = 1500 // ms entre requêtes au même domaine

function markHit(domain) {
  RATE.set(domain, Date.now())
}

function gapOk(domain) {
  const last = RATE.get(domain) || 0
  return Date.now() - last >= MIN_GAP
}

async function waitGap(domain) {
  const elapsed = Date.now() - (RATE.get(domain) || 0)
  if (elapsed < MIN_GAP) await new Promise((r) => setTimeout(r, MIN_GAP - elapsed))
  markHit(domain)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ODDS — Toutes les sources en parallèle
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOdds_football_data_live(match) {
  const fd = getFootballDataLive()
  if (!fd || !fd.isAvailable()) return null
  try {
    const fake = {
      homeTeam: match.homeTeam || match.home_team,
      awayTeam: match.awayTeam || match.away_team,
      startTimestamp: match.startTimestamp || Math.floor(Date.now() / 1000),
    }
    const odds = await fd.fetchOddsForMatch(fake)
    if (!odds || odds._odds_no_data) return null
    return {
      home: odds.home, draw: odds.draw, away: odds.away,
      over25: odds.over25, under25: odds.under25,
      btts_yes: odds.btts_yes, btts_no: odds.btts_no,
      source: 'football_data_live', bookmaker: true, latency_ms: 0,
    }
  } catch (e) {
    return null
  }
}

async function fetchOdds_sofascore_api(match) {
  const svc = getSofascoreOdds()
  if (!svc) return null
  try {
    const odds = await withTimeout(Promise.resolve(svc.fetchOddsForMatch(match)), FETCH_TIMEOUT_MS)
    if (!odds) return null
    return {
      home: odds.home, draw: odds.draw, away: odds.away,
      over25: odds.over25, under25: odds.under25,
      btts_yes: odds.btts_yes, btts_no: odds.btts_no,
      source: 'sofascore_api', bookmaker: true, latency_ms: 0,
    }
  } catch (e) {
    return null
  }
}

async function fetchOdds_sofascore_bypass(match) {
  const bypass = getSofascoreBypass()
  if (!bypass) return null
  try {
    const odds = await withTimeout(Promise.resolve(bypass.getOddsForMatch(match)), FETCH_TIMEOUT_MS)
    if (!odds || !odds.home) return null
    return {
      home: odds.home, draw: odds.draw, away: odds.away,
      over25: odds.over25, under25: odds.under25,
      btts_yes: odds.btts_yes, btts_no: odds.btts_no,
      source: 'sofascore_bypass', bookmaker: true, latency_ms: 0,
    }
  } catch (e) {
    return null
  }
}

async function fetchOdds_betexplorer_1x2(match) {
  const be = getBetExplorer()
  if (!be) return null
  const home = match.homeTeam || match.home_team
  const away = match.awayTeam || match.away_team
  const league = match.league || ''
  const country = match.country || ''
  const key = oddsKey('be1x2', match.id, home, away)
  const cached = cacheGet(key)
  if (cached) return cached
  try {
    await waitGap('betexplorer.com')
    const result = await be.getOdds1x2(home, away, league, country, '', null)
    if (!result || !result.home_win) return null
    const data = {
      home: result.home_win, draw: result.draw, away: result.away_win,
      source: 'betexplorer_1x2', bookmaker: true, latency_ms: result._elapsed || 0,
    }
    cacheSet(key, data)
    return data
  } catch (e) {
    return null
  }
}

async function fetchOdds_betexplorer_full(match) {
  const be = getBetExplorer()
  if (!be) return null
  const home = match.homeTeam || match.home_team
  const away = match.awayTeam || match.away_team
  const league = match.league || ''
  const country = match.country || ''
  const key = oddsKey('befull', match.id, home, away)
  const cached = cacheGet(key)
  if (cached) return cached
  try {
    await waitGap('betexplorer.com')
    const result = await be.getOdds(home, away, league, country, '', null)
    if (!result || !result.home_win) return null
    const data = {
      home: result.home_win, draw: result.draw, away: result.away_win,
      over25: result.over_25, under25: result.under_25,
      btts_yes: result.btts_yes, btts_no: result.btts_no,
      source: 'betexplorer_full', bookmaker: true, latency_ms: result._elapsed || 0,
    }
    cacheSet(key, data)
    return data
  } catch (e) {
    return null
  }
}

async function fetchOdds_jina_flashscore(match) {
  const jina = getJina()
  if (!jina) return null
  const league = match.league || ''
  const slug = LEAGUE_SLUGS[league]
  if (!slug) return null
  const url = `https://www.flashscore.com/football/${slug}/odds-comparison/`
  const key = oddsKey('jina_fs', match.id, match.homeTeam, match.awayTeam)
  const cached = cacheGet(key)
  if (cached) return cached
  try {
    const result = await jina.fetchUrl(url, 20000)
    if (!result || !result.data) return null
    const odds = parseOddsFromHtml(result.data)
    if (!odds) return null
    cacheSet(key, odds)
    return odds
  } catch (e) {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LIVE SCORES
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  FAIR ODDS — dernier recours depuis le modèle
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFairOdds_estimate(match) {
  const { fetchFairOdds } = require('./FairOddsEstimator')
  try {
    const odds = await fetchFairOdds(match)
    if (!odds) return null
    return {
      home: odds.home || null,
      draw: odds.draw || null,
      away: odds.away || null,
      over25: odds.over25 || null,
      under25: odds.under25 || null,
      btts_yes: odds.btts_yes || null,
      btts_no: odds.btts_no || null,
      source: 'fair_odds_model',
      bookmaker: false,
      confidence: odds.confidence || 'low',
      method: odds.method || 'unknown',
    }
  } catch (e) {
    return null
  }
}


async function fetchLivescores(dateStr) {
  const ls = getLiveScore()
  if (!ls) return null
  try {
    return await ls.fetch(dateStr || new Date().toISOString().slice(0, 10))
  } catch (e) {
    return null
  }
}

async function fetchResults_soccerway(league) {
  const jina = getSoccerwayJina()
  if (!jina || !jina.getResults) return null
  try {
    return await jina.getResults(league)
  } catch (e) {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  INJURIES / ABSENCES
// ─────────────────────────────────────────────────────────────────────────────

async function fetchInjuries_sofascore(match) {
  const bypass = getSofascoreBypass()
  if (!bypass) return null
  try {
    const result = await bypass.getAbsencesForMatch(match)
    if (!result || !result.found) return null
    return {
      found: result.found,
      eventId: result.eventId,
      impact: result.impact || null,
      source: 'sofascore_bypass',
    }
  } catch (e) {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATS (HT score, corners)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStats_sofascore(match) {
  const bypass = getSofascoreBypass()
  if (!bypass) return null
  try {
    const result = await bypass.getEventStats(match)
    if (!result || !result.found) return null
    return {
      ht_h: result.ht_h, ht_a: result.ht_a,
      c_ft_h: result.c_ft_h, c_ft_a: result.c_ft_a,
      c_ht_h: result.c_ht_h, c_ht_a: result.c_ht_a,
      source: 'sofascore_bypass',
    }
  } catch (e) {
    return null
  }
}

async function fetchXg_sofascore(sofascoreId) {
  try {
    const { fetchMatchXg } = require('./sofascoreXgService')
    const xg = await fetchMatchXg(sofascoreId)
    return xg ? { home_xg: xg.home_xg, away_xg: xg.away_xg, source: 'sofascore_xg' } : null
  } catch (e) {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARSING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const LEAGUE_SLUGS = {
  'Premier League': 'england/premier-league',
  'Ligue 1': 'france/ligue-1',
  'LaLiga': 'spain/laliga',
  'Bundesliga': 'germany/bundesliga',
  'Serie A': 'italy/serie-a',
  'Eredivisie': 'netherlands/eredivisie',
  'Primeira Liga': 'portugal/primeira-liga',
  'Süper Lig': 'turkey/super-lig',
  'Champions League': 'europe/champions-league',
}

function parseOddsFromHtml(html) {
  if (!html || html.length < 200) return null
  const valRe = /class="odds__value[^>]*>([^<]+)<\/div>/g
  const vals = []
  let m
  while ((m = valRe.exec(html)) !== null) {
    const v = parseFloat(m[1].replace(',', '.'))
    if (Number.isFinite(v) && v >= 1.01 && v <= 20) vals.push(v)
  }
  if (vals.length < 3) return null
  const rows = []
  for (let i = 0; i + 2 < vals.length; i += 3) {
    rows.push({ home: vals[i], draw: vals[i + 1], away: vals[i + 2] })
  }
  if (rows.length === 0) return null
  const best = rows.reduce(
    (b, c) => ({
      home: Math.max(b.home, c.home),
      draw: Math.max(b.draw, c.draw),
      away: Math.max(b.away, c.away),
    }),
    { home: 0, draw: 0, away: 0 }
  )
  if (best.home === 0) return null
  return { home: best.home, draw: best.draw, away: best.away, source: 'flashscore_jina', bookmaker: true }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ORCHESTRATOR — fetchOddsForMatch
//  Strategie: lancer TOUS les fetchers en parallèle, prendre la meilleure cote
//  NOTE: SofascoreAPI peut bloquer 480s si 403 — chaque appel est timeouté 8s
// ─────────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8000

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function fetchOddsForMatch(match) {
  const home = match.homeTeam || match.home_team || ''
  const away = match.awayTeam || match.away_team || ''
  const key = oddsKey('any', match.id, home, away)
  const cached = cacheGet(key)
  if (cached) return cached

  // Lancer TOUS les fetchers en parallèle (Promise.allSettled)
  // SofascoreAPI peut dormir 480s sur 403 — on timeout tout à 8s
  const promises = [
    fetchOdds_football_data_live(match).catch(() => null),
    withTimeout(fetchOdds_sofascore_api(match).catch(() => null), FETCH_TIMEOUT_MS).catch(() => null),
    withTimeout(fetchOdds_sofascore_bypass(match).catch(() => null), FETCH_TIMEOUT_MS).catch(() => null),
    withTimeout(fetchOdds_betexplorer_1x2(match).catch(() => null), FETCH_TIMEOUT_MS).catch(() => null),
    withTimeout(fetchOdds_betexplorer_full(match).catch(() => null), FETCH_TIMEOUT_MS).catch(() => null),
  ]

  const results = await Promise.allSettled(promises)
  const valid = results
    .filter((r) => r.status === 'fulfilled' && r.value && (r.value.home || r.value.over25))
    .map((r) => r.value)

  if (valid.length === 0) {
    // Dernier recours : calculer des cotes "justes" depuis le modèle (xG / Elo / probabilités)
    // bookmaker=false car ce ne sont PAS des cotes bookmaker
    const fair = await fetchFairOdds_estimate(match)
    if (fair) {
      cacheSet(key, fair)
      return fair
    }
    cacheSet(key, null)
    return null
  }

  // Comparaison des cotes : choisir la meilleure (plus haute) pour chaque marché
  const best = {
    home: null, draw: null, away: null,
    over25: null, under25: null,
    btts_yes: null, btts_no: null,
    sources_used: [],
    comparison: {},
  }

  for (const o of valid) {
    if (!best.sources_used.includes(o.source)) best.sources_used.push(o.source)
    if (o.home && (!best.home || o.home > best.home)) best.home = o.home
    if (o.draw && (!best.draw || o.draw > best.draw)) best.draw = o.draw
    if (o.away && (!best.away || o.away > best.away)) best.away = o.away
    if (o.over25 && (!best.over25 || o.over25 > best.over25)) best.over25 = o.over25
    if (o.under25 && (!best.under25 || o.under25 > best.under25)) best.under25 = o.under25
    if (o.btts_yes && (!best.btts_yes || o.btts_yes > best.btts_yes)) best.btts_yes = o.btts_yes
    if (o.btts_no && (!best.btts_no || o.btts_no > best.btts_no)) best.btts_no = o.btts_no
    if (!best.comparison[o.source]) best.comparison[o.source] = {}
    if (o.home) best.comparison[o.source].home = o.home
    if (o.draw) best.comparison[o.source].draw = o.draw
    if (o.away) best.comparison[o.source].away = o.away
    if (o.over25) best.comparison[o.source].over25 = o.over25
  }

  if (!best.home && !best.over25) {
    cacheSet(key, null)
    return null
  }

  best.source = `ultimate:${best.sources_used.length}-sources`
  best.bookmaker = true

  cacheSet(key, best)
  logger.info(`[ULTIMATE] ${home} vs ${away}: ${valid.length} sources, best home=${best.home} draw=${best.draw} away=${best.away}`)
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
//  LIVE SCORES — fetch pour une date
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLiveScores(dateStr) {
  const key = `livescore:${dateStr || 'today'}`
  const cached = cacheGet(key)
  if (cached) return cached
  const ls = await fetchLivescores(dateStr)
  if (ls && ls.length > 0) {
    cacheSet(key, ls)
  }
  return ls
}

// ─────────────────────────────────────────────────────────────────────────────
//  RESULTS — fetch pour une league
// ─────────────────────────────────────────────────────────────────────────────

async function fetchResults(league) {
  const key = `results:${league}`
  const cached = cacheGet(key)
  if (cached) return cached
  const results = await fetchResults_soccerway(league)
  if (results && results.length > 0) {
    cacheSet(key, results)
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
//  FULL PIPELINE — injuries + stats + xg pour un match
// ─────────────────────────────────────────────────────────────────────────────

async function fetchMatchEnrichment(match) {
  const [injuries, stats, xg] = await Promise.allSettled([
    fetchInjuries_sofascore(match).catch(() => null),
    fetchStats_sofascore(match).catch(() => null),
    fetchXg_sofascore(match.sofascore_id || match._sofaMatchId || match.id).catch(() => null),
  ])

  return {
    injuries: injuries.status === 'fulfilled' ? injuries.value : null,
    stats: stats.status === 'fulfilled' ? stats.value : null,
    xg: xg.status === 'fulfilled' ? xg.value : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STATUS
// ─────────────────────────────────────────────────────────────────────────────

function getStatus() {
  return {
    name: 'UltimateScraperOrchestrator',
    type: 'free',
    cache_size: CACHE.size,
    cache_ttl_min: CACHE_TTL / 60000,
    sources: {
      football_data_live: getFootballDataLive()?.getStats?.() || null,
      sofascore_api: getSofascoreOdds() ? { available: true, markets: '1X2,O/U,BTTS,Corners,DC,HT/FT,AH' } : null,
      sofascore_bypass: getSofascoreBypass() ? { available: true, type: 'curl_cffi' } : null,
      betexplorer_1x2: getBetExplorer() ? { available: true, type: 'curl_cffi' } : null,
      betexplorer_full: getBetExplorer() ? { available: true, type: 'curl_cffi' } : null,
      livescore_api: getLiveScore() ? { available: true, leagues: '~62 worldwide' } : null,
      soccerway_jina: getSoccerwayJina() ? { available: true, type: 'r.jina.ai' } : null,
    },
  }
}

function clearCache() {
  CACHE.clear()
}

module.exports = {
  fetchOddsForMatch,
  fetchLiveScores,
  fetchResults,
  fetchMatchEnrichment,
  getStatus,
  clearCache,
}
