/**
 * SofascoreBypass — accès à l'API publique Sofascore via curl_cffi
 * (contournement du ban TLS/IP par fingerprints navigateur, 100 % gratuit).
 *
 * Chaîne : Node -> scripts/sofascore_bypass.py (venv curl_cffi) -> api.sofascore.com
 * resolve : /search/all -> team id -> /team/{id}/events/{next,last}/0 -> event id
 * odds    : /event/{id}/odds/1/all (fractionnel -> decimal)
 *
 * Kill-switch : DISABLE_SOFASCORE=true (respecté côté dataFusionService).
 */
const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'sofascore_bypass.py')
const CACHE_TTL_EVENT = 12 * 3600 * 1000
const CACHE_TTL_ODDS = 10 * 60 * 1000

let pyCache = null

function pickPython() {
  if (pyCache) return pyCache
  const candidates = [
    path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'),
    path.join(__dirname, '..', '..', '.venv', 'bin', 'python'),
    path.join(__dirname, '..', '..', 'data_pipeline', '.venv', 'Scripts', 'python.exe'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      pyCache = p
      return p
    }
  }
  pyCache = 'python'
  return pyCache
}

function callPy(args, timeoutMs = 35000) {
  return new Promise((resolve) => {
    execFile(
      pickPython(),
      [SCRIPT, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        const line = String(stdout || '')
          .split(/\r?\n/)
          .filter((l) => l.trim().startsWith('{'))
          .pop()
        if (!line) return resolve(null)
        try {
          resolve(JSON.parse(line))
        } catch (_) {
          resolve(null)
        }
      }
    )
  })
}

function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const eventCache = new Map() // "home|away" -> { eventId, startTimestamp, expiresAt }
const oddsCache = new Map() // eventId -> { odds, expiresAt }

async function resolveEvent(homeTeam, awayTeam, startTimestamp) {
  const key = `${normKey(homeTeam)}|${normKey(awayTeam)}`
  const hit = eventCache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.eventId
  const args = ['resolve', '--home', String(homeTeam || ''), '--away', String(awayTeam || '')]
  if (startTimestamp) args.push('--ts', String(Math.floor(startTimestamp / 1000)))
  const res = await callPy(args)
  if (res && res.found && res.event_id) {
    eventCache.set(key, {
      eventId: res.event_id,
      startTimestamp: res.start_timestamp,
      expiresAt: Date.now() + CACHE_TTL_EVENT,
    })
    return res.event_id
  }
  return null
}

async function getOdds(eventId) {
  const hit = oddsCache.get(eventId)
  if (hit && Date.now() < hit.expiresAt) return hit.odds
  const res = await callPy(['odds', '--event', String(eventId)])
  if (res && res.found && res.odds) {
    oddsCache.set(eventId, { odds: res.odds, expiresAt: Date.now() + CACHE_TTL_ODDS })
    return res.odds
  }
  return null
}

/**
 * @param {{homeTeam:string, awayTeam:string, startTimestamp?:number, sofascore_id?:number|string}} match
 * @returns {Promise<Object|null>} cotes décimales réelles ou null (jamais d'exception)
 */
async function getOddsForMatch(match) {
  try {
    if (!match || !match.homeTeam || !match.awayTeam) return null
    let eventId =
      match.sofascore_id != null ? Number(match.sofascore_id) : null
    if (!eventId) {
      eventId = await resolveEvent(match.homeTeam, match.awayTeam, match.startTimestamp)
    }
    if (!eventId) return null
    const odds = await getOdds(eventId)
    if (!odds) return null
    const has1x2 = odds.home != null && odds.away != null
    const hasOu = odds.over25 != null || odds.under25 != null
    const hasBtts = odds.btts_yes != null || odds.btts_no != null
    if (!has1x2 && !hasOu && !hasBtts) return null
    return {
      home: has1x2 ? odds.home : null,
      draw: has1x2 ? odds.draw ?? null : null,
      away: has1x2 ? odds.away : null,
      over25: odds.over25 ?? null,
      under25: odds.under25 ?? null,
      btts_yes: odds.btts_yes ?? null,
      btts_no: odds.btts_no ?? null,
      source: 'sofascore',
      bookmaker: true,
    }
  } catch (_) {
    return null
  }
}

module.exports = { getOddsForMatch, resolveEvent, getOdds }
