// content.js — Sofascore Day Collector
// Tourne DANS la page sofascore.com : les fetch sont same-origin, les cookies
// du challenge JS sont joints automatiquement (c'est ce que prouve le projet :
// curl_cffi reçoit 403 "challenge", le vrai navigateur passe).
//
// Séquence (message SOFA_RUN reçu du background) :
//   1. tournois programmés du jour   -> /sport/football/scheduled-tournaments/J/page/N
//   2. fixtures de chaque tournoi    -> /unique-tournament/{id}/scheduled-events/J
//   3. POST vers l'API locale        -> /api/scraper/sofascore/collect  (répond 'wanted')
//   4. cotes UNIQUEMENT des 'wanted' -> /event/{id}/odds/{1,5,6}/featured
//   5. POST vers l'API locale        -> /api/scraper/sofascore/ingest   (persistOdds)

const SOFA_API = 'https://www.sofascore.com/api/v1'
const MARKET_IDS = [1, 5, 6] // 1X2 / Over-Under 2.5 / BTTS (mêmes ids que SofascoreOddsService)
const MAX_TOURNAMENT_PAGES = 60
const CONCURRENCY = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function progress(stage, detail) {
  try {
    chrome.runtime.sendMessage({ type: 'SOFA_PROGRESS', stage, detail })
  } catch (_) {}
}

async function apiGet(path) {
  const res = await fetch(SOFA_API + path, { credentials: 'include' })
  if (res.status === 403) {
    const err = new Error('Sofascore 403 challenge (page à recharger pour re-solve le JS)')
    err.code = 'CHALLENGE'
    throw err
  }
  if (res.status === 404) return null // tournoi/marché absent : pas une erreur
  if (!res.ok) {
    const err = new Error(`Sofascore HTTP ${res.status} sur ${path}`)
    err.code = 'HTTP_' + res.status
    throw err
  }
  return res.json()
}

// 1) Liste des uniqueTournament.id programmés pour la journée (paginé).
async function listTournamentIds(day) {
  const ids = []
  for (let page = 1; page <= MAX_TOURNAMENT_PAGES; page++) {
    const j = await apiGet(`/sport/football/scheduled-tournaments/${day}/page/${page}`)
    if (!j) break
    for (const item of j.scheduled || []) {
      const t = (item && item.tournament) || {}
      const id = (t.uniqueTournament && t.uniqueTournament.id) || t.id
      if (id) ids.push(id)
    }
    if (!j.hasNextPage) break
    await sleep(120 + Math.random() * 180)
    progress('tournois', `${page} pages, ${ids.length} tournois`)
  }
  return [...new Set(ids)]
}

// 2) Fixtures de chaque tournoi (concurrence bornée + jitter, comme un humain).
async function listFixtures(tournamentIds, day) {
  const fixtures = []
  let cursor = 0
  const worker = async () => {
    while (cursor < tournamentIds.length) {
      const id = tournamentIds[cursor++]
      try {
        const j = await apiGet(`/unique-tournament/${id}/scheduled-events/${day}`)
        for (const e of (j && j.events) || []) {
          if (!e || !e.id || !e.homeTeam || !e.awayTeam) continue
          fixtures.push({
            eventId: e.id,
            homeTeam: e.homeTeam.name,
            awayTeam: e.awayTeam.name,
            league: (e.tournament && e.tournament.name) || null,
            startTimestamp: e.startTimestamp || null,
            status: (e.status && e.status.code) || null,
          })
        }
      } catch (err) {
        if (err.code === 'CHALLENGE') throw err // on abandonne proprement
      }
      progress('fixtures', `${fixtures.length} matchs, ${cursor}/${tournamentIds.length} tournois`)
      await sleep(90 + Math.random() * 160)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return fixtures
}

// 4) Cotes des seuls matchs voulus par le serveur. Les payloads bruts sont
//    ré-expédiés : c'est le serveur qui les parse (parseFeaturedOdds et consorts),
//    donc zéro logique de parsing dupliquée dans le navigateur.
async function fetchMarkets(eventId) {
  const markets = {}
  for (const mid of MARKET_IDS) {
    try {
      const j = await apiGet(`/event/${eventId}/odds/${mid}/featured`)
      if (j) markets[`m${mid}`] = j
    } catch (err) {
      if (err.code === 'CHALLENGE') throw err
    }
    await sleep(50 + Math.random() * 120)
  }
  return markets
}

async function run(day) {
  progress('debut', `journée ${day}`)

  const tournamentIds = await listTournamentIds(day)
  if (!tournamentIds.length) return { ok: false, error: 'aucun tournoi programmé' }

  const fixtures = await listFixtures(tournamentIds, day)

  // 3) Le serveur trace les fixtures et ne veut QUE celles de notre base.
  const collect = await chrome.runtime.sendMessage({ type: 'SOFA_COLLECT', day, fixtures })
  if (!collect || !collect.ok) {
    throw new Error((collect && collect.error) || 'collecte refusée par l’API locale')
  }
  const wanted = collect.wanted || []

  // 4) Cotes uniquement pour les matchs de notre base.
  const rows = []
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i]
    rows.push({ ...w, markets: await fetchMarkets(w.eventId) })
    progress('cotes', `${i + 1}/${wanted.length}`)
  }

  // 5) Ecriture (database.persistOdds, odds_source = 'sofascore').
  const ingest = await chrome.runtime.sendMessage({ type: 'SOFA_INGEST', day, rows })
  if (!ingest || !ingest.ok) {
    throw new Error((ingest && ingest.error) || 'ingestion refusée par l’API locale')
  }

  const summary = {
    ok: true,
    day,
    tournois: tournamentIds.length,
    fixtures: fixtures.length,
    voulus: wanted.length,
    persistes: ingest.persisted || 0,
    sansCote: ingest.noOdds || 0,
    inconnus: ingest.unknown || 0,
  }
  progress('termine', JSON.stringify(summary))
  return summary
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'SOFA_RUN') return
  const day = /^\d{4}-\d{2}-\d{2}$/.test(msg.day || '') ? msg.day : todayLocal()
  run(day)
    .then((r) => sendResponse(r))
    .catch((e) => {
      progress('erreur', e.message)
      sendResponse({ ok: false, error: e.message })
    })
  return true // réponse asynchrone
})
