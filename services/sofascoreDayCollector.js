// services/sofascoreDayCollector.js — E85
//
// Pipeline « journée Sofascore » :
//   1. POST /api/scraper/sofascore/collect   <- extension (fixtures de la journée)
//      le service trace les fixtures sur disque et retourne LA LISTE des
//      rencontres présentes dans notre base (= celles dont on veut les cotes).
//   2. L'extension ne fetch donc que les marchés de ces rencontres-là.
//   3. POST /api/scraper/sofascore/ingest    <- extension (fixtures + cotes)
//      ecriture via database.persistOdds (source = 'sofascore').
//
// Aucune dependance navigateur ici : tout est offline-testable.
const path = require('path')
const fs = require('fs')
const logger = require('../core/logger')

const DATA_DIR = path.join(__dirname, '..', 'data')

// ── Normalisation des noms d'équipes ────────────────────────────────────────
// Même philosophie que getMatchByTeams (core/db/matches.js) : on plie les
// accents, on vire la ponctuation et les tokens « bruit » (FC, Club...) puis
// on compare en containment mutuel. Sofascore écrit « FC Tampa Bay Rowdies »
// là où le reste du projet écrit « Tampa Bay Rowdies ».
const NOISE = new Set([
  'fc', 'ac', 'cf', 'sc', 'afc', 'rc', 'us', 'as', 'ca', 'cd',
  'cda', 'cs', 'cr', 'sp', 'sa', 'club', 'de', 'do', 'da', 'du',
  'the', 'bk', 'if', 'sk', 'ss', 'tsg', 'vfb', 'vfl', 'sv',
])

function tokenize(name) {
  if (!name) return []
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w))
}

const hit = (token, list) =>
  list.some((w) => w.includes(token) || (token.length > 2 && w.length >= 3 && token.includes(w)))

// Chevauchement significatif : au moins un token commun de 4+ caractères, ou
// deux listes strictement égales (cas des noms très courts type « PSG »).
// Sans ce garde, le containment seul matcherait des équipes sans rapport.
function significantOverlap(a, b) {
  const common = a.filter((w) => hit(w, b))
  if (common.some((w) => w.length >= 4)) return true
  return a.length === b.length && a.every((w) => b.includes(w))
}

function pairMatch(fxName, dbName) {
  const a = tokenize(fxName)
  const b = tokenize(dbName)
  if (!a.length || !b.length) return false
  if (!significantOverlap(a, b)) return false
  // Containment dans UN seul sens : tolère les qualificatifs ajoutés par
  // Sofascore (« Club Atlético Chacarita Juniors » vs « Chacarita Juniors »,
  // « FC Tampa Bay Rowdies » vs « Tampa Bay Rowdies »).
  return a.every((w) => hit(w, b)) || b.every((w) => hit(w, a))
}

function fixturesMatch(fx, db) {
  const direct =
    pairMatch(fx.homeTeam, db.homeTeam) && pairMatch(fx.awayTeam, db.awayTeam)
  if (direct) return true
  // Journée retour : certains flux inversent locateur/visiteur.
  return pairMatch(fx.homeTeam, db.awayTeam) && pairMatch(fx.awayTeam, db.homeTeam)
}

// ── Matchs candidats ────────────────────────────────────────────────────────
// Le format de date de la colonne `timestamp` dépend de l'ingesteur (UTC ou
// local) : on charge J-1, J et J+1 et on dédoublonne. C'est trois requêtes
// SQL simples, bien moins coûteux qu'un getAllMatches() complet.
async function loadDbCandidates(day) {
  const database = require('../core/database')
  const d = new Date(`${day}T00:00:00Z`)
  const fmt = (dt) => dt.toISOString().slice(0, 10)
  const days = [
    fmt(new Date(d.getTime() - 86400000)),
    day,
    fmt(new Date(d.getTime() + 86400000)),
  ]
  const out = new Map()
  for (const dstr of days) {
    try {
      const rows = await database.getMatchesByDate(dstr)
      for (const r of rows) if (r && r.id) out.set(r.id, r)
    } catch (e) {
      logger.warn(`[SOFA_DAY] getMatchesByDate(${dstr}) : ${e.message}`)
    }
  }
  // Filet : si le format timestamp ne matche pas (colonne absente/incohérente),
  // on retombe sur la fenêtre glissante existante.
  if (!out.size) {
    try {
      const soon = await database.getMatchesStartingSoon(48)
      for (const r of soon) if (r && r.id) out.set(r.id, r)
    } catch (e) {
      logger.warn(`[SOFA_DAY] getMatchesStartingSoon : ${e.message}`)
    }
  }
  return [...out.values()]
}

function fixturesFile(day) {
  return path.join(DATA_DIR, `sofascore_fixtures_${day}.json`)
}

function saveFixtures(day, fixtures) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const payload = { day, savedAt: new Date().toISOString(), count: fixtures.length, fixtures }
    fs.writeFileSync(fixturesFile(day), JSON.stringify(payload, null, 2))
    return true
  } catch (e) {
    logger.warn(`[SOFA_DAY] ecriture fixtures impossible : ${e.message}`)
    return false
  }
}

// ── Phase 1 : fixtures du jour -> cibles DB ────────────────────────────────
async function collect(day, fixtures) {
  const list = Array.isArray(fixtures) ? fixtures.filter((f) => f && f.eventId && f.homeTeam && f.awayTeam) : []
  const candidates = await loadDbCandidates(day)

  const wanted = []
  const matchedIds = new Set()
  let alreadyDone = 0
  for (const fx of list) {
    const db = candidates.find((m) => !matchedIds.has(m.id) && fixturesMatch(fx, m))
    if (db) {
      matchedIds.add(db.id)
      // Reprise : un match déjà alimenté par Sofascore n'est pas re-demandé,
      // ce qui rend un run interrompu reprenable sans tout refetcher.
      if (db.odds_source === 'sofascore' && db.odds_home) {
        alreadyDone++
        continue
      }
      wanted.push({
        eventId: fx.eventId,
        matchId: db.id,
        homeTeam: fx.homeTeam,
        awayTeam: fx.awayTeam,
        league: fx.league || db.league || null,
        startTimestamp: fx.startTimestamp || null,
      })
    }
  }

  const saved = saveFixtures(day, list)
  logger.info(
    `[SOFA_DAY] ${day} : ${list.length} fixtures reçues, ${candidates.length} matchs DB, ` +
      `${matchedIds.size} appariés (${alreadyDone} déjà faits, ${wanted.length} à fetcher)`
  )
  return {
    day,
    saved,
    fixtures: list.length,
    dbCandidates: candidates.length,
    matched: matchedIds.size,
    alreadyDone,
    unmatched: list.length - matchedIds.size,
    wanted,
  }
}

// ── Phase 3 : fixtures enrichies de cotes -> base ──────────────────────────
// `rows` : [{ eventId, matchId?, homeTeam, awayTeam, startTimestamp,
//            markets: { m1, m5, m6 }  <- payloads /featured bruts }]
// Les payloads bruts sont parsés ICI par les parseurs déjà exportés par
// services/sofascoreOddsService (parseFeaturedOdds / parseOverUnder25 /
// parseBtts) : une seule implémentation, jamais dupliquée dans l'extension.
// `row.odds` (home/draw/away/over25/under25/bttsYes/bttsNo) reste accepté
// comme entrée déjà parsée — utilisé par les tests.
function parseMarkets(markets) {
  const sofa = require('./sofascoreOddsService')
  const m1 = markets && markets.m1 ? sofa.parseFeaturedOdds(markets.m1) : null
  const m5 = markets && markets.m5 ? sofa.parseOverUnder25(markets.m5) : null
  const m6 = markets && markets.m6 ? sofa.parseBtts(markets.m6) : null
  const out = {}
  if (m1) {
    out.home = m1.home
    out.draw = m1.draw
    out.away = m1.away
  }
  if (m5) {
    out.over25 = m5.over25
    out.under25 = m5.under25
  }
  if (m6) {
    out.bttsYes = m6.btts_yes
    out.bttsNo = m6.btts_no
  }
  return out
}

async function ingest(day, rows) {
  const database = require('../core/database')
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.eventId) : []
  if (!list.length) return { day, received: 0, persisted: 0, unknown: 0, noOdds: 0 }

  let candidates = null
  const stats = { received: list.length, persisted: 0, unknown: 0, noOdds: 0, failed: 0 }

  for (const row of list) {
    const odds = row.odds || parseMarkets(row.markets)
    const hasOdds =
      [odds.home, odds.draw, odds.away].every((v) => typeof v === 'number' && v > 1.0)
    if (!hasOdds) {
      stats.noOdds++
      continue
    }

    let matchId = row.matchId || null
    if (!matchId) {
      if (!candidates) candidates = await loadDbCandidates(day)
      const db = candidates.find((m) => fixturesMatch(row, m))
      if (!db) {
        stats.unknown++
        continue
      }
      matchId = db.id
    }

    const ok = database.persistOdds(matchId, {
      odds_home: odds.home,
      odds_draw: odds.draw,
      odds_away: odds.away,
      odds_over25: odds.over25 ?? null,
      odds_under25: odds.under25 ?? null,
      odds_btts_yes: odds.bttsYes ?? null,
      odds_btts_no: odds.bttsNo ?? null,
      odds_source: 'sofascore',
      odds_fetch_error: null,
    })
    if (ok) stats.persisted++
    else stats.failed++
  }

  logger.info(
    `[SOFA_DAY] ingest ${day} : ${stats.persisted} cotes ecrites (source=sofascore), ` +
      `${stats.noOdds} sans cote, ${stats.unknown} inconnues, ${stats.failed} en echec`
  )
  return { day, ...stats }
}

module.exports = {
  collect,
  ingest,
  fixturesMatch,
  parseMarkets,
}
