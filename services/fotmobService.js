/**
 * fotmobService.js — FotMob stats via API + __NEXT_DATA__ fallback.
 *
 * Sources:
 *  - getMatchDetails() : xG, corners, HT score, shots, possession, lineups
 *  - getMatchScore()   : lightweight live score
 *  - getMatchesByDate(): all matches for a date
 *
 * Anti-ban: curl_cffi TLS impersonation + rate limiting (2s) + negative cache (1h).
 * Fallback: if /api/matchDetails 404 → parse __NEXT_DATA__ from HTML page.
 *
 * Integration: fallback_enricher.js / free_fallback_service.py cascade.
 */

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const BASE_DIR = path.resolve(__dirname, '..')
const PYTHON = path.join(BASE_DIR, '.venv', os.platform() === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
const SCRIPT = path.join(BASE_DIR, 'scripts', 'fotmobClient.py')

const CACHE_TTL_MS = 60 * 60 * 1000  // 1h
const cache = new Map()

function _key(fn, args) {
  return `${fn}:${JSON.stringify(args)}`
}

function _get(key) {
  const e = cache.get(key)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null }
  return e.data
}

function _set(key, data) {
  cache.set(key, { data, ts: Date.now() })
}

function _callPy(fn, args) {
  return new Promise((resolve, reject) => {
    const key = _key(fn, args)
    const cached = _get(key)
    if (cached !== null) { resolve(cached); return }

    const proc = spawn(PYTHON, [SCRIPT, fn, JSON.stringify(args)], {
      cwd: BASE_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = '', err = ''
    proc.stdout.on('data', c => { out += c })
    proc.stderr.on('data', c => { err += c })
    proc.on('close', code => {
      if (code !== 0) { reject(new Error(`fotmobClient.py exit ${code}: ${err.slice(0, 200)}`)); return }
      try {
        const parsed = JSON.parse(out)
        if (parsed && parsed.error) { reject(new Error(parsed.error)); return }
        _set(key, parsed)
        resolve(parsed)
      } catch (e) {
        reject(new Error(`Invalid JSON: ${e.message}. Raw: ${out.slice(0, 200)}`))
      }
    })
    proc.on('error', reject)
  })
}

async function getMatchDetails(matchId) {
  try {
    return await _callPy('get_match_details', { match_id: String(matchId) })
  } catch (e) {
    console.error(`[FOTMOB] getMatchDetails(${matchId}) failed: ${e.message}`)
    return null
  }
}

async function getMatchScore(matchId) {
  try {
    return await _callPy('get_match_score', { match_id: String(matchId) })
  } catch (e) {
    console.error(`[FOTMOB] getMatchScore(${matchId}) failed: ${e.message}`)
    return null
  }
}

async function getMatchesByDate(dateStr) {
  // dateStr: YYYYMMDD
  try {
    return await _callPy('get_matches_by_date', { date: dateStr })
  } catch (e) {
    console.error(`[FOTMOB] getMatchesByDate(${dateStr}) failed: ${e.message}`)
    return null
  }
}

module.exports = { getMatchDetails, getMatchScore, getMatchesByDate }
