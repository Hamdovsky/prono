// 🔗 ODDS BACKFILL — lie les matchs LiveScore (sans cotes) aux cotes
// des sources externes par (nom équipe normalisé + date).
// Source-agnostique : réutilise les mapEventToMatch existants.
// Désactivé automatiquement si aucune clé API n'est configurée (isAvailable()).

const database = require('./database')
const logger = require('./logger')

const therundownService = require('../services/therundownService')
const oddspapiService = require('../services/oddspapiService')
const sportmonksService = require('../services/sportmonksService')
const bsdService = new Proxy({}, { get: (t, p) => (p === 'isAvailable' ? () => false : (p === 'then' ? undefined : (async () => null))) });
const oddsApiIoService = require('../services/oddsApiIoService')
const bypassScraper = require('../services/scrapers/ScrapingBypassScraper')

const BETEXPLORER_CAP = Number(process.env.BETEXPLORER_BACKFILL_CAP || 30)

// Budget temps global (ms) : stoppe le scan dès qu'il est dépassé,
// car les échecs BetExplorer peuvent coûter ~60s chacun sur 589 targets.
const BACKFILL_TIME_BUDGET_MS = Number(process.env.BETEXPLORER_BACKFILL_TIMEOUT_MS || 60000)

// Normaliseur minimal (backend CommonJS — le normaliseur frontend est ESM)
function normalizeTeam(name) {
  if (!name || typeof name !== 'string') return ''
  let s = name.toLowerCase().trim()
  try {
    s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  } catch (_) {}
  s = s
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const suffixes = [
    ' fc',
    ' f.c.',
    ' sc',
    ' ac',
    ' afc',
    ' us',
    ' as',
    ' cf',
    ' united',
    ' city',
    ' town',
    ' athletic',
    ' sporting',
    ' real',
    ' racing',
    ' club',
    ' b',
    ' ii',
    ' iii',
    ' u23',
    ' u21',
    ' u20',
    ' u19',
    ' reserves',
    ' reserve',
    ' youth',
    ' academy',
  ]
  for (const suf of suffixes) {
    if (s.endsWith(suf)) {
      s = s.slice(0, -suf.length).trim()
      break
    }
  }
  return s
}

function matchKey(home, away) {
  return `${normalizeTeam(home)}|${normalizeTeam(away)}`
}

function getDateStr(offset) {
  const d = new Date()
  d.setDate(d.getDate() + (offset || 0))
  return d.toISOString().split('T')[0]
}

const ODDS_SOURCES = [
  {
    name: 'therundown',
    available: () => therundownService.isAvailable(),
    fetch: async (dateStr) => {
      const events = await therundownService.fetchSoccerEvents(dateStr)
      if (!events || !events.length) return []
      return events.map((e) => therundownService.mapEventToMatch(e))
    },
  },
  {
    name: 'oddspapi',
    available: () => oddspapiService.isAvailable(),
    fetch: (dateStr) => oddspapiService.fetchEvents(dateStr),
  },
  {
    name: 'sportmonks',
    available: () => sportmonksService.isAvailable(),
    fetch: (dateStr) => sportmonksService.fetchEvents(dateStr),
  },
  {
    name: 'bsd',
    available: () =>
      bsdService.isAvailable() && typeof bsdService.fetchEventsWithOdds === 'function',
    fetch: (dateStr) => bsdService.fetchEventsWithOdds(dateStr),
  },
  {
    name: 'oddsapiio',
    available: () =>
      oddsApiIoService.isAvailable() && typeof oddsApiIoService.fetchEventsWithOdds === 'function',
    fetch: (dateStr) => oddsApiIoService.fetchEventsWithOdds(dateStr),
  },
]

async function buildOddsPool() {
  const pool = new Map() // key -> { odds_home, odds_draw, odds_away, source, dateStr }
  const dates = []
  for (let i = 0; i <= 6; i++) dates.push(getDateStr(i))

  for (const src of ODDS_SOURCES) {
    if (!src.available()) {
      logger.info(`[ODDS-BACKFILL] ${src.name} indisponible (clé API manquante?)`)
      continue
    }
    for (const dateStr of dates) {
      try {
        const matches = await src.fetch(dateStr)
        if (!matches || !matches.length) continue
        for (const m of matches) {
          if (!m.homeTeam || !m.awayTeam) continue
          const oh = parseFloat(m.odds_home)
          const od = parseFloat(m.odds_draw)
          const oa = parseFloat(m.odds_away)
          if (!oh && !od && !oa) continue
          const k = matchKey(m.homeTeam, m.awayTeam)
          if (!pool.has(k)) {
            pool.set(k, {
              odds_home: oh || null,
              odds_draw: od || null,
              odds_away: oa || null,
              source: src.name,
              dateStr,
              bsd_match_id: m.bsd_match_id || null,
            })
          }
        }
      } catch (e) {
        logger.warn(`[ODDS-BACKFILL] ${src.name} ${dateStr}: ${e.message}`)
      }
    }
  }
  return pool
}

async function backfillOdds() {
  const db = database.db
  if (!db) return { scanned: 0, updated: 0, error: 'no db' }

  const nowSec = Math.floor(Date.now() / 1000)
  // Cible prioritaire : les matchs les plus proches de "maintenant" (passés d'hier
  // exclus) — tri ABS puis LIMIT 200 pour que le budget temps profite aux matchs
  // qui comptent pour le dashboard, pas aux milliers de matchs périmés.
  const targets = db
    .prepare(
      `SELECT id, "homeTeam", "awayTeam", league, category_name, startTimestamp FROM matches
     WHERE source='livescore'
       AND (odds_home IS NULL OR odds_draw IS NULL OR odds_away IS NULL)
       AND status='scheduled'
       AND startTimestamp >= ${nowSec - 86400}
     ORDER BY ABS(startTimestamp - ${nowSec}) ASC
     LIMIT 200`
    )
    .all()

  if (!targets.length) {
    logger.info('[ODDS-BACKFILL] Aucun match LiveScore sans cotes à compléter.')
    return { scanned: 0, updated: 0, betexplorerUpdated: 0 }
  }

  const pool = await buildOddsPool()
  logger.info(
    `[ODDS-BACKFILL] ${pool.size} cotes candidates | ${targets.length} matchs LiveScore ciblés`
  )

  if (!pool.size) {
    logger.warn(
      '[ODDS-BACKFILL] Aucune cote disponible via pool — les sources API sont désactivées, fallback BetExplorer seul.'
    )
  }

  let updated = 0
  let bsdLinked = 0
  let betexplorerUpdated = 0
  const startTs = Date.now()
  const updateStmt = db.prepare(
    `UPDATE matches SET odds_home=?, odds_draw=?, odds_away=?, odds_source=?, last_updated=? WHERE id=?`
  )
  const linkBsd = db.prepare(
    `UPDATE matches SET bsd_match_id=? WHERE id=? AND (bsd_match_id IS NULL OR bsd_match_id='')`
  )
  for (const t of targets) {
    if (Date.now() - startTs >= BACKFILL_TIME_BUDGET_MS) {
      logger.warn(
        `[ODDS-BACKFILL] Budget temps atteint (${BACKFILL_TIME_BUDGET_MS}ms) — arrêt après ${updated + betexplorerUpdated} mises à jour.`
      )
      break
    }
    const cand =
      pool.get(matchKey(t.homeTeam, t.awayTeam)) || pool.get(matchKey(t.awayTeam, t.homeTeam))
    if (cand) {
      updateStmt.run(cand.odds_home, cand.odds_draw, cand.odds_away, cand.source, Date.now(), t.id)
      updated++
      if (cand.bsd_match_id) {
        linkBsd.run(String(cand.bsd_match_id), t.id)
        bsdLinked++
      }
      continue
    }
    // 🆓 Fallback gratuit : BetExplorer via bypass scraper (per-match, cache 10min).
    if (betexplorerUpdated >= BETEXPLORER_CAP) continue
    try {
      const altOdds = await bypassScraper.getOdds1x2(
        t.homeTeam,
        t.awayTeam,
        t.league || '',
        t.category_name || '',
        t.startTimestamp || Date.now()
      )
      if (altOdds && altOdds.home_win) {
        updateStmt.run(
          altOdds.home_win,
          altOdds.draw || null,
          altOdds.away_win || null,
          'betexplorer',
          Date.now(),
          t.id
        )
        betexplorerUpdated++
        logger.info(
          `[ODDS-BACKFILL/BETEXPLORER] ${t.homeTeam} vs ${t.awayTeam} (${t.league || '?'}): H=${altOdds.home_win} D=${altOdds.draw} A=${altOdds.away_win}`
        )
      }
    } catch (e) {
      logger.warn(`[ODDS-BACKFILL/BETEXPLORER] ${t.homeTeam} vs ${t.awayTeam}: ${e.message}`)
    }
  }

  logger.info(
    `[ODDS-BACKFILL] Terminé: ${updated}/${targets.length} matchs complétés via pool (${bsdLinked} liés BSD), ${betexplorerUpdated} via BetExplorer (budget ${Date.now() - startTs}ms).`
  )
  return { scanned: targets.length, updated, bsdLinked, betexplorerUpdated, elapsedMs: Date.now() - startTs }
}

module.exports = { backfillOdds, buildOddsPool }
