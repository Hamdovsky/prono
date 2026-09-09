// Source plugin: Livescore.com public API (primary, covers all 62 leagues).
// Free, keyless, scheduled fixtures only (J / J+1 / J+2).
//
// Self-contained (axios only) on purpose: it must NOT import core/cloudSeed,
// whose module load pulls in heavy services that can hang on network calls.

const axios = require('axios')

const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app/date/soccer'
const LIVESCORE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.livescore.com',
  Referer: 'https://www.livescore.com/',
}

// Retry / robustesse (alignée sur openligadb qui backoffe déjà 429/5xx).
// La source primaire est unique pour les fixtures ET les résultats : une erreur
// réseau transitoire fait perdre toute une date jusqu'au prochain scan (~3 h),
// et un 200 « blocage souple » (payload sans Stages) était compté comme succès
// 0 match = panne silencieuse. On retente les deux, puis on laisse remonter.
const RETRY_ATTEMPTS = Math.max(0, Number(process.env.LIVESCORE_RETRIES ?? 2))
const RETRY_BASE_MS = 800

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Erreurs réseau éphémères / 5xx / throttling dignes d'une nouvelle tentative.
function _isRetryable(err) {
  const status = err?.response?.status
  if (status === 408 || status === 425 || status === 429) return true
  if (status >= 500 && status <= 599) return true
  const code = err?.code || ''
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_NETWORK|ECONNABORTED|network/i.test(
    `${code} ${err?.message || ''}`
  )
}

function parseEsd(esd) {
  const s = String(esd)
  if (s.length < 14) return Math.floor(Date.now() / 1000)
  const year = s.slice(0, 4)
  const mon = s.slice(4, 6)
  const day = s.slice(6, 8)
  const hour = s.slice(8, 10)
  const min = s.slice(10, 12)
  const sec = s.slice(12, 14)
  return Math.floor(new Date(`${year}-${mon}-${day}T${hour}:${min}:${sec}Z`).getTime() / 1000)
}

function baseEvent(event, stage) {
  if (!event?.Eid) return null
  const homeName = event.T1?.[0]?.Nm || 'Home'
  const awayName = event.T2?.[0]?.Nm || 'Away'
  if (homeName === 'Home' || awayName === 'Away') return null
  const ts = event.Esd ? parseEsd(event.Esd) : Math.floor(Date.now() / 1000)
  const league = stage?.Snm || 'Unknown'
  return {
    id: `livescore_${event.Eid}`,
    homeTeam: homeName,
    awayTeam: awayName,
    league,
    category_name: stage?.CompD || stage?.Cnm || '',
    country: stage?.Cnm || '',
    tournament_name: stage?.CompN || league,
    tournament_id: stage?.CompId ? Number(stage.CompId) : null,
    home_team_id: event.T1?.[0]?.ID ? Number(event.T1[0].ID) : null,
    away_team_id: event.T2?.[0]?.ID ? Number(event.T2[0].ID) : null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    source: 'livescore',
    last_updated: Date.now(),
  }
}

// Scheduled fixtures only (not started / empty status).
function mapEvent(event, stage) {
  const m = baseEvent(event, stage)
  if (!m) return null
  return { ...m, status: 'scheduled' }
}

// Finished events with final scores (Tr1/Tr2) and half-time (Trh1/Trh2).
// Keeps the same teams/date mapping so the match_key matches the stored fixture.
function mapResult(event, stage) {
  const m = baseEvent(event, stage)
  if (!m) return null
  const eps = (event.Eps || '').toUpperCase()
  if (!['FT', 'AET', 'PEN'].includes(eps)) return null
  const scoreHome = parseInt(event.Tr1, 10)
  const scoreAway = parseInt(event.Tr2, 10)
  if (Number.isNaN(scoreHome) || Number.isNaN(scoreAway)) return null
  return {
    ...m,
    status: 'finished',
    scoreHome,
    scoreAway,
    scoreHalfHome: parseInt(event.Trh1, 10) || 0,
    scoreHalfAway: parseInt(event.Trh2, 10) || 0,
  }
}

async function _getDateEvents(dateStr, attempt = 0) {
  const ymd = dateStr.replace(/-/g, '')
  const url = `${LIVESCORE_BASE}/${ymd}/0?MD=1&countryCode=US&locale=en`
  try {
    const { data } = await axios.get(url, {
      headers: LIVESCORE_HEADERS,
      timeout: 20000,
    })
    // Une réponse SANS tableau Stages n'est JAMAIS un « jour vide » valide
    // (un jour vide renvoie Stages: [] — vérifié). C'est un blocage souple /
    // payload HTML / corps tronqué : on le traite comme une erreur.
    if (!Array.isArray(data?.Stages)) {
      const err = new Error(`livescore ${dateStr}: payload invalide (Stages absent)`)
      err.malformed = true
      throw err
    }
    return data.Stages
  } catch (err) {
    if ((err.malformed || _isRetryable(err)) && attempt < RETRY_ATTEMPTS) {
      const backoff = RETRY_BASE_MS * (attempt + 1) + Math.floor(Math.random() * 250)
      await _sleep(backoff)
      return _getDateEvents(dateStr, attempt + 1)
    }
    throw err
  }
}

async function fetch(dateStr) {
  const stages = await _getDateEvents(dateStr)
  const out = []
  for (const stage of stages) {
    for (const event of stage?.Events || []) {
      const eps = (event.Eps || '').toUpperCase()
      if (eps !== 'NS' && eps !== '') continue
      const match = mapEvent(event, stage)
      if (match) out.push(match)
    }
  }
  return out
}

async function fetchResults(dateStr) {
  const stages = await _getDateEvents(dateStr)
  const out = []
  for (const stage of stages) {
    for (const event of stage?.Events || []) {
      const match = mapResult(event, stage)
      if (match) out.push(match)
    }
  }
  return out
}

module.exports = {
  name: 'livescore',
  priority: 1,
  type: 'fixtures',
  // Réactivé le 2026-09-09 : la désactivation du 2026-09-04 (« API retourne
  // error ») était un diagnostic périmé — probe du jour : HTTP 200, 65 stages,
  // 173 évènements. Désactivable sans toucher au code via LIVESCORE_ENABLED=false.
  enabled: process.env.LIVESCORE_ENABLED !== 'false',
  // Avoid hammering the public API across the 3 scan dates.
  rate: { max: 6, perMs: 60000, minTime: 1500 },
  fetch,
  fetchResults,
  mapEvent,
  mapResult,
  // Test hook (pas de depends du pipeline) : _getDateEvents + classificateur.
  _internals: { _getDateEvents, _isRetryable },
}
