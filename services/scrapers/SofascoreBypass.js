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

const lineupsCache = new Map() // eventId -> { data, expiresAt }

async function getLineups(eventId) {
  if (eventId == null) return null
  const hit = lineupsCache.get(eventId)
  if (hit && Date.now() < hit.expiresAt) return hit.data
  const res = await callPy(['lineups', '--event', String(eventId)])
  if (res && res.found) {
    lineupsCache.set(eventId, { data: res, expiresAt: Date.now() + CACHE_TTL_EVENT })
    return res
  }
  return null
}

async function getInjuries(eventId) {
  if (eventId == null) return null
  const res = await callPy(['injuries', '--event', String(eventId)])
  if (res && res.found) return res
  return null
}

// Stats de match terminé : HT score + corners FT/HT (cache long — immuable après FT)
const statsCache = new Map() // eventId -> { data, expiresAt }
const CACHE_TTL_STATS = 7 * 24 * 3600 * 1000

/**
 * HT score + corners (FT et 1ère MT) d'un événement terminé.
 * @returns {Promise<{ht_h?,ht_a?,c_ft_h?,c_ft_a?,c_ht_h?,c_ht_a?}|null>} null si rien trouvé
 */
async function getEventStats(eventId) {
  if (eventId == null) return null
  const hit = statsCache.get(eventId)
  if (hit && Date.now() < hit.expiresAt) return hit.data
  const res = await callPy(['stats', '--event', String(eventId)])
  if (res && res.found) {
    statsCache.set(eventId, { data: res, expiresAt: Date.now() + CACHE_TTL_STATS })
    return res
  }
  return null
}

// Poids par poste (impact sur xG attendu) — défense/poste bas, attaque élevé.
const POS_WEIGHT = { G: 1.0, D: 0.5, M: 0.6, F: 0.7 }
// Sévérité par statut d'absence.
const STATUS_WEIGHT = { injured: 1.0, suspended: 1.0, doubtful: 0.4 }

/**
 * Calcule l'impact pondéré des absences par côté (home/away), 0..1.
 * @param {Array<{team?:string,player?:string,position?:string,status?:string}>} items
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @returns {{home:number, away:number}}
 */
function computeAbsenceImpact(items, homeTeam, awayTeam) {
  const hk = normKey(homeTeam)
  const ak = normKey(awayTeam)
  const acc = { home: 0, away: 0 }
  for (const r of items || []) {
    const side =
      normKey(r.team) === hk ? 'home' : normKey(r.team) === ak ? 'away' : 'unknown'
    if (side === 'unknown') continue
    const pos = String(r.position || '').toUpperCase().slice(0, 1)
    const w = (STATUS_WEIGHT[String(r.status || '').toLowerCase()] || 0.6) *
      (POS_WEIGHT[pos] != null ? POS_WEIGHT[pos] : 0.5)
    acc[side] += w
  }
  // Normalisation : ~3 absences clés saturent l'impact à 1.0.
  return {
    home: Math.min(1, +(acc.home / 3).toFixed(3)),
    away: Math.min(1, +(acc.away / 3).toFixed(3)),
  }
}

/**
 * Phase 9 : résout l'event, récupère les absences, persiste dans player_absences,
 * et renvoie l'impact pondéré. Jamais d'exception (kill-switch friendly).
 * @returns {Promise<{found:boolean, impact?:{home:number,away:number}, eventId?:number|null}>}
 */
async function getAbsencesForMatch(match) {
  try {
    if (!match || !match.homeTeam || !match.awayTeam) return { found: false }
    let eventId =
      match.sofascore_id != null ? Number(match.sofascore_id) : null
    if (!eventId) eventId = await resolveEvent(match.homeTeam, match.awayTeam, match.startTimestamp)
    if (!eventId) return { found: false }
    const inj = await getInjuries(eventId)
    if (!inj || !inj.found) return { found: false, eventId }
    const rows = (inj.injuries || []).map((r) => ({
      side: normKey(r.team) === normKey(match.homeTeam) ? 'home'
        : normKey(r.team) === normKey(match.awayTeam) ? 'away' : 'unknown',
      team: r.team,
      player: r.player,
      position: r.position,
      status: r.status,
      detail: r.detail,
    }))
    try {
      const db = require('../../core/database')
      if (db && db.savePlayerAbsences) db.savePlayerAbsences(eventId, rows)
    } catch (_) {
      // persistance best-effort ; ne bloque pas le calcul d'impact
    }
    return { found: true, eventId, impact: computeAbsenceImpact(inj.injuries, match.homeTeam, match.awayTeam) }
  } catch (_) {
    return { found: false }
  }
}

module.exports = {
  getOddsForMatch,
  resolveEvent,
  getOdds,
  getLineups,
  getInjuries,
  getEventStats,
  getAbsencesForMatch,
  computeAbsenceImpact,
}
