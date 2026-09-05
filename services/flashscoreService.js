/**
 * flashscoreService.js — Flashscore stats via internal feed API.
 *
 * Sources:
 *  - getMatchStats()  : xG, corners, shots, cards, HT score (from df_st_1_ feed)
 *  - getMatchIncidents(): goals, cards, referee (from df_sui_1_ feed)
 *  - getTodayFixtures(): fixtures du jour (anglais) + ids de matchs Flashscore
 *  - getMatchOdds()   : cotes 1X2 (best bookmaker) avec output d'ouverture + drift
 *                         via persisted-query GraphQL (global.ds.lsapp.eu, headless)
 *  - getBookmakers()  : liste id/name des bookmakers d'un match
 *
 * Anti-ban: curl_cffi TLS impersonation + X-Fsign header + rate limiting (2s).
 * Negative cache: 1h per matchId (avoids re-fetching known-missing matches).
 *
 * Integration point: UltimateScraperOrchestrator — fallback when Sofascore
 * returns no HT/corners/xG for a match.
 */

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const BASE_DIR = path.resolve(__dirname, '..')

let _py = null
function pyBinary() {
  if (_py) return _py
  const candidates = [
    path.join(BASE_DIR, '.venv', os.platform() === 'win32' ? 'Scripts/python.exe' : 'bin/python3'),
    path.join(BASE_DIR, '.venv', 'bin', 'python'),
    '/opt/venv/bin/python3', // Dockerfile.production
    'python3',
    'python',
  ]
  for (const p of candidates) {
    try {
      if (require('fs').existsSync(p)) {
        _py = p
        return p
      }
    } catch (_) {
      /* ignore */
    }
  }
  _py = 'python'
  return _py
}
const SCRIPT = path.join(BASE_DIR, 'scripts', 'flashscoreClient.py')

const CACHE_TTL_MS = 60 * 60 * 1000  // 1h
const cache = new Map()

function _pythonCacheKey(fn, args) {
  return `${fn}:${JSON.stringify(args)}`
}

function _fromCache(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null }
  return entry.data
}

function _toCache(key, data) {
  cache.set(key, { data, ts: Date.now() })
}

function _callPython(fn, args) {
  return new Promise((resolve, reject) => {
    const key = _pythonCacheKey(fn, args)
    const cached = _fromCache(key)
    if (cached !== null) { resolve(cached); return }

    const proc = spawn(pyBinary(), [SCRIPT, fn, JSON.stringify(args)], {
      cwd: BASE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', c => { stdout += c })
    proc.stderr.on('data', c => { stderr += c })
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`flashscoreClient.py exited ${code}: ${stderr.slice(0, 300)}`))
        return
      }
      try {
        const out = JSON.parse(stdout)
        if (out && out.error) {
          reject(new Error(out.error))
          return
        }
        _toCache(key, out)
        resolve(out)
      } catch (e) {
        reject(new Error(`Invalid JSON from flashscoreClient.${fn}: ${e.message}. Raw: ${stdout.slice(0, 200)}`))
      }
    })
    proc.on('error', reject)
  })
}

/**
 * Fetch match stats (xG, corners, shots, cards, HT score).
 * @param {string} matchId — Flashscore match ID (numeric string)
 * @returns {Promise<object|null>}
 */
async function getMatchStats(matchId) {
  try {
    return await _callPython('get_match_stats', { match_id: String(matchId) })
  } catch (e) {
    console.error(`[FLASHSCORE] getMatchStats(${matchId}) failed: ${e.message}`)
    return null
  }
}

/**
 * Fetch match incidents (goals, cards, referee).
 * @param {string} matchId
 * @returns {Promise<object|null>}
 */
async function getMatchIncidents(matchId) {
  try {
    return await _callPython('get_match_incidents', { match_id: String(matchId) })
  } catch (e) {
    console.error(`[FLASHSCORE] getMatchIncidents(${matchId}) failed: ${e.message}`)
    return null
  }
}

/**
 * Fixtures du jour (toutes les ligues, noms anglais). Chaque fixture expose
 * l'id Flashscore (`id`), home, away, league et le timestamp de coup d'envoi.
 * @returns {Promise<Array<{id:string,home:string,away:string,league:string,start:string}>>}
 */
async function getTodayFixtures() {
  try {
    const res = await _callPython('get_today_fixtures', {})
    return Array.isArray(res) ? res : []
  } catch (e) {
    console.error(`[FLASHSCORE] getTodayFixtures failed: ${e.message}`)
    return []
  }
}

/**
 * Liste des bookmakers (id + nom) disponibles pour un match.
 * @param {string} matchId
 * @returns {Promise<Array<{id:number,name:string}>>}
 */
async function getBookmakers(matchId) {
  try {
    const res = await _callPython('get_bookmakers', { match_id: String(matchId) })
    return Array.isArray(res) ? res : []
  } catch (e) {
    console.error(`[FLASHSCORE] getBookmakers(${matchId}) failed: ${e.message}`)
    return []
  }
}

/**
 * Meilleures cotes 1X2 (premier bookmaker avec cotes) pour un match Flashscore.
 * Retourne {home, draw, away, opening:{home,draw,away}, change, active, bookmakerId}.
 * @param {string} matchId
 * @param {number[]} [bookmakerIds] — prise en charge auto si absent
 * @returns {Promise<object|null>}
 */
async function getMatchOdds(matchId, bookmakerIds) {
  try {
    return await _callPython('get_match_odds', {
      match_id: String(matchId),
      bookmaker_ids: Array.isArray(bookmakerIds) && bookmakerIds.length ? bookmakerIds : null,
    })
  } catch (e) {
    console.error(`[FLASHSCORE] getMatchOdds(${matchId}) failed: ${e.message}`)
    return null
  }
}

/**
 * Cotes multi-marchés pour un match Flashscore (bet365 puis 1xBet...).
 * Clés : bookmakerId, scrapedAt + un objet par betType présent :
 *  HOME_DRAW_AWAY {home,draw,away,opening,active,change}
 *  DOUBLE_CHANCE  {homeOrDraw,awayOrDraw,noDraw,active}
 *  BOTH_TEAMS_TO_SCORE {yes,no,active}
 *  OVER_UNDER     [{line,over,under,active_over,active_under,change}]
 *  ASIAN_HANDICAP [{line,home,away,active_home,active_away}]
 *  CORRECT_SCORE  [{score,odds}]
 * `betTypes` limite les marchés à récupérer (moins d'appels → moins de rate-limit).
 * @param {string} matchId
 * @param {string[]} [betTypes]
 * @param {number[]} [bookmakerIds]
 * @returns {Promise<object|null>}
 */
async function getMatchMarkets(matchId, betTypes, bookmakerIds) {
  try {
    return await _callPython('get_match_markets', {
      match_id: String(matchId),
      bet_types: Array.isArray(betTypes) && betTypes.length ? betTypes : null,
      bookmaker_ids: Array.isArray(bookmakerIds) && bookmakerIds.length ? bookmakerIds : null,
    })
  } catch (e) {
    console.error(`[FLASHSCORE] getMatchMarkets(${matchId}) failed: ${e.message}`)
    return null
  }
}

/**
 * Normalisation du nom d'équipe pour le matching fixtures Flashscore.
 * Minuscules, sans accents, suffixes courants retirés (fc/cf/ac/…), stopwords courts supprimés.
 * @param {string} s
 * @returns {string}
 */
function normalizeTeam(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|ac|cd|as|af|ud|sm|ss|club|sportivo)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .join(' ')
}

/**
 * Résout l'id Flashscore d'un match (home/away + ligue + kickoff optionnels)
 * en s'appuyant sur la liste des fixtures du jour (feed global, cache 1h).
 * @param {string} home
 * @param {string} away
 * @param {string} [league]
 * @param {number|string} [startTimestamp] — ms (ou s), pour lever l'ambiguité de matchs rejoués
 * @returns {Promise<string|null>}
 */
async function findMatchId(home, away, league, startTimestamp) {
  try {
    const fixtures = await getTodayFixtures()
    if (!fixtures.length) return null
    const h = normalizeTeam(home)
    const a = normalizeTeam(away)
    const lg = league ? String(league).toLowerCase() : ''
    const lgWords = lg
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !['cup', 'col','toto','principality'].includes(w))
    let targetMs = parseInt(String(startTimestamp || ''), 10)
    if (targetMs && targetMs < 1e12) targetMs *= 1000 // secondes → ms

    for (const f of fixtures) {
      if (normalizeTeam(f.home) !== h || normalizeTeam(f.away) !== a) continue
      if (lgWords.length && f.league) {
        const fl = String(f.league).toLowerCase()
        if (!lgWords.some((w) => fl.includes(w))) continue
      }
      if (targetMs && f.start) {
        let rawMs = parseInt(String(f.start), 10)
        if (rawMs && rawMs < 1e12) rawMs *= 1000 // secondes → ms
        if (Math.abs(targetMs - rawMs) > 6 * 3600 * 1000) continue
      }
      return f.id
    }
    return null
  } catch (e) {
    console.error(`[FLASHSCORE] findMatchId(${home} vs ${away}) failed: ${e.message}`)
    return null
  }
}

module.exports = { getMatchStats, getMatchIncidents, getTodayFixtures, getBookmakers, getMatchOdds, getMatchMarkets, findMatchId, normalizeTeam }
