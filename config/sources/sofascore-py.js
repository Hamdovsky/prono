// Source plugin: fixtures Sofascore via PixelRAG (core/visual_server.py, :30002).
//
// ⚠️ STATUT 2026-09-09 : OPT-IN seulement. Sofascore a bloqué ses endpoints
// par date (scheduled-events/{date} → 404 WAF ; seuls events/live et event/{id}
// répondent encore, vérifié curl_cffi chrome124). Le endpoint /fixtures de
// PixelRAG rend la forme normale dès que Sofascore rouvre l'API — activer :
//   PIXELRAG_FIXTURES_ENABLED=true
// Tant qu'il est désactivé, Livescore (priority 1) reste la source primaire.
//
// Contract: GET {PIXELRAG_URL}/fixtures/YYYY-MM-DD ->
//   { success, date, count, events: [{ eid, homeTeam, awayTeam, homeTeamId,
//     awayTeamId, league, category_name, startTimestamp (s), status
//     ('scheduled'|'inprogress'|'finished'), scoreHome?, scoreAway? }] }

const axios = require('axios')

const PIXELRAG_BASE = process.env.PIXELRAG_URL || 'http://127.0.0.1:30002'

async function getFixtures(dateStr) {
  const { data } = await axios.get(`${PIXELRAG_BASE}/fixtures/${dateStr}`, { timeout: 25000 })
  if (!data || data.success !== true) {
    throw new Error(`pixelrag fixtures: ${data && data.error ? data.error : 'payload invalide'}`)
  }
  return Array.isArray(data.events) ? data.events : []
}

function canonicalRow(e) {
  return {
    id: `sofascore_${e.eid}`,
    homeTeam: e.homeTeam,
    awayTeam: e.awayTeam,
    league: e.league || 'Unknown',
    category_name: e.category_name || '',
    country: e.category_name || '',
    tournament_name: e.league || 'Unknown',
    home_team_id: e.homeTeamId ?? null,
    away_team_id: e.awayTeamId ?? null,
    startTimestamp: Number(e.startTimestamp),
    timestamp: new Date(Number(e.startTimestamp) * 1000).toISOString(),
    source: 'sofascore',
    last_updated: Date.now(),
  }
}

async function fetch(dateStr) {
  const events = await getFixtures(dateStr)
  return events
    .filter(
      (e) =>
        e &&
        e.status === 'scheduled' &&
        e.homeTeam &&
        e.awayTeam &&
        Number.isFinite(Number(e.startTimestamp))
    )
    .map((e) => ({ ...canonicalRow(e), status: 'scheduled' }))
}

async function fetchResults(dateStr) {
  const events = await getFixtures(dateStr)
  return events
    .filter(
      (e) =>
        e &&
        e.status === 'finished' &&
        Number.isInteger(e.scoreHome) &&
        Number.isInteger(e.scoreAway)
    )
    .map((e) => ({
      ...canonicalRow(e),
      status: 'finished',
      scoreHome: e.scoreHome,
      scoreAway: e.scoreAway,
    }))
}

module.exports = {
  name: 'sofascore-py',
  priority: 2,
  type: 'fixtures',
  // Opt-in : voir entête (endpoints par date Sofascore actuellement 404 WAF).
  enabled: process.env.PIXELRAG_FIXTURES_ENABLED === 'true',
  timeoutMs: 30000,
  // Sofascore est pointilleux : 6 dates/min max (le serveur PixelRAG cache 15 min).
  rate: { max: 6, perMs: 60000, minTime: 2000, maxConcurrent: 1 },
  fetch,
  fetchResults,
}
