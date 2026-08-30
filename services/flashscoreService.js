/**
 * flashscoreService.js — Flashscore stats via internal feed API.
 *
 * Sources:
 *  - getMatchStats()  : xG, corners, shots, cards, HT score (from df_st_1_ feed)
 *  - getMatchIncidents(): goals, cards, referee (from df_sui_1_ feed)
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
const PYTHON = path.join(BASE_DIR, '.venv', os.platform() === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
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

    const proc = spawn(PYTHON, [SCRIPT, fn, JSON.stringify(args)], {
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

module.exports = { getMatchStats, getMatchIncidents }
