const axios = require('axios')
const database = require('./database')
const logger = require('./logger')
const { createQuotaManager } = require('../services/sourceQuotaManager')
const rapidApiQuotaManager = require('../services/rapidApiQuotaManager')
const bsdService = require('../services/bsdService')
const therundownService = require('../services/therundownService')
const oddspapiService = require('../services/oddspapiService')
const sportmonksService = require('../services/sportmonksService')
const apifootballService = require('../services/apifootballService')
const openligadbService = require('../services/openligadbService')

const fdQuotaManager = createQuotaManager('footballdata')

const TIER1_TOURNAMENT_IDS = new Set([
  17, 8, 23, 35, 7, 37, 679, 329, 34, 44, 238, 45, 203, 574
])

function getDateStr(offset) {
  const d = new Date()
  d.setDate(d.getDate() + (offset || 0))
  return d.toISOString().split('T')[0]
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

const SOFASCORE_BASE = 'https://www.sofascore.com/api/v1'

async function fetchSofascoreEvents(date) {
  try {
    const { data } = await axios.get(`${SOFASCORE_BASE}/sport/football/scheduled-events/${date}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      timeout: 20000
    })
    if (data?.events?.length > 0) {
      logger.info(`[SOFASCORE] ${date}: ${data.events.length} events trouvés`)
    }
    return data?.events || []
  } catch (e) {
    logger.warn(`[SOFASCORE] Fetch failed for ${date}: ${e.message}`)
    return []
  }
}

function mapSofascoreEventToMatch(event) {
  const ts = event.startTimestamp || Math.floor(Date.now() / 1000)
  const rawStatus = (event.status?.type || '').toLowerCase()
  const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus) ? rawStatus : 'scheduled'

  const homeName = event.homeTeam?.name || event.homeTeam?.slug || 'Home'
  const awayName = event.awayTeam?.name || event.awayTeam?.slug || 'Away'

  if (homeName === 'Home' || awayName === 'Away' || !event.id) return null

  return {
    id: `sofascore_${event.id}`,
    homeTeam: homeName,
    awayTeam: awayName,
    league: event.tournament?.uniqueTournament?.name || event.tournament?.name || 'Unknown',
    category_name: event.tournament?.category?.name || '',
    tournament_name: event.tournament?.name || '',
    tournament_id: event.tournament?.uniqueTournament?.id || null,
    home_team_id: event.homeTeam?.id || null,
    away_team_id: event.awayTeam?.id || null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'sofascore',
    fullData: JSON.stringify({ id: event.id, homeTeam: homeName, awayTeam: awayName, league: event.tournament?.name, startTimestamp: ts, status, seasonId: event.season?.id, sofaMatchId: event.id })
  }
}

const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com'
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || ''
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}/api/v1`

async function fetchRapidApiEvents(date) {
  if (!RAPIDAPI_KEY || process.env.RAPIDAPI_ENABLED !== 'true') return []
  try {
    const { data } = await axios.get(`${RAPIDAPI_BASE}/sport/football/scheduled-events/${date}`, {
      headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': RAPIDAPI_KEY, 'Accept': 'application/json' },
      timeout: 20000
    })
    return data.events || []
  } catch (e) {
    return []
  }
}

function isTier1(event) {
  const tid = event.tournament?.uniqueTournament?.id
  return tid && TIER1_TOURNAMENT_IDS.has(Number(tid))
}

function mapRapidEventToMatch(event) {
  const ts = event.startTimestamp || Math.floor(Date.now() / 1000)
  const rawStatus = (event.status?.type || '').toLowerCase()
  const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus) ? rawStatus : 'scheduled'
  return {
    id: String(event.id),
    homeTeam: event.homeTeam?.name || 'Home',
    awayTeam: event.awayTeam?.name || 'Away',
    league: event.tournament?.name || 'Unknown',
    category_name: event.tournament?.category?.name || '',
    tournament_name: event.tournament?.name || '',
    tournament_id: event.tournament?.uniqueTournament?.id || null,
    home_team_id: event.homeTeam?.id || null,
    away_team_id: event.awayTeam?.id || null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'rapidapi',
    fullData: JSON.stringify({ id: event.id, homeTeam: event.homeTeam?.name, awayTeam: event.awayTeam?.name, league: event.tournament?.name, startTimestamp: ts, status })
  }
}

const FD_KEY  = process.env.FOOTBALLDATA_KEY || ''
const FD_HOST = process.env.FOOTBALLDATA_HOST || 'footballdata.io'
const FD_BASE = `https://${FD_HOST}/api/v1`

async function fetchFDFixtures(endpoint) {
  if (!FD_KEY || process.env.FOOTBALLDATA_ENABLED !== 'true') return []
  try {
    const { data } = await axios.get(`${FD_BASE}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${FD_KEY}`, 'Accept': 'application/json' },
      timeout: 20000
    })
    const root = data?.data || data
    return root?.matches || root?.fixtures || []
  } catch (e) {
    return []
  }
}

function mapFDFixtureToMatch(f) {
  const matchId = f.match_id || f.id || `fd_${Date.now()}_${Math.random()}`
  const ts = f.date_unix || f.timestamp || Math.floor(Date.now() / 1000)
  const rawStatus = (f.status || '').toLowerCase()
  let status = 'scheduled'
  if (rawStatus === 'complete' || rawStatus === 'ft') status = 'finished'
  else if (rawStatus === 'live' || rawStatus === 'inprogress') status = 'inprogress'
  return {
    id: `fd_${matchId}`,
    homeTeam: f.home_team?.team_name || f.home_team?.name || f.homeTeam || 'Home',
    awayTeam: f.away_team?.team_name || f.away_team?.name || f.awayTeam || 'Away',
    league: f.league?.competition_name || f.league?.name || f.competition || 'Unknown',
    category_name: f.league?.country || '',
    tournament_name: f.league?.competition_name || f.league?.name || f.competition || 'Unknown',
    tournament_id: f.league?.competition_id || null,
    home_team_id: f.home_team?.team_id || null,
    away_team_id: f.away_team?.team_id || null,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    status,
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: f.odds?.home_win || null,
    odds_draw: f.odds?.draw || null,
    odds_away: f.odds?.away_win || null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'footballdata',
    fullData: JSON.stringify({ home: f.home_team?.name || f.homeTeam || 'Home', away: f.away_team?.name || f.awayTeam || 'Away', league: f.league?.name || 'Unknown', startTimestamp: ts, status })
  }
}

async function upsertMatch(match) {
  try {
    const db = database.db
    if (!db) return false
    if (['finished', 'canceled', 'postponed'].includes(match.status)) return false
    const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')
    if (isPG) {
      const cols = ['id', '"homeTeam"', '"awayTeam"', 'league', 'category_name', 'tournament_name',
        'tournament_id', 'home_team_id', 'away_team_id',
        '"startTimestamp"', 'timestamp', 'status',
        'confidence', 'prediction',
        'odds_home', 'odds_draw', 'odds_away',
        'last_updated', 'insufficient_data', 'source', '"fullData"']
      const vals = cols.map((_, i) => `$${i + 1}`).join(', ')
      const params = cols.map(c => match[c] !== undefined ? match[c] : null)
      await db.prepare(
        `INSERT INTO matches (${cols.join(', ')}) VALUES (${vals}) ON CONFLICT (id) DO NOTHING`
      ).run(params)
      return true
    }
    await db.prepare(`
      INSERT OR IGNORE INTO matches (
        id, homeTeam, awayTeam, league, category_name, tournament_name,
        tournament_id, home_team_id, away_team_id,
        startTimestamp, timestamp, status,
        confidence, prediction,
        odds_home, odds_draw, odds_away,
        last_updated, insufficient_data, source, fullData
      ) VALUES (
        @id, @homeTeam, @awayTeam, @league, @category_name, @tournament_name,
        @tournament_id, @home_team_id, @away_team_id,
        @startTimestamp, @timestamp, @status,
        @confidence, @prediction,
        @odds_home, @odds_draw, @odds_away,
        @last_updated, @insufficient_data, @source, @fullData
      )
    `).run(match)
    return true
  } catch (e) {
    logger.warn(`[CLOUD-SEED] upsertMatch error (${match.id}):`, e.message)
    return false
  }
}

async function countMatchesForPeriod(dayOffsetStart, dayOffsetEnd) {
  try {
    const db = database.db
    const startDate = getDateStr(dayOffsetStart)
    const endDate   = getDateStr(dayOffsetEnd)
    const startTs = Math.floor(new Date(startDate + 'T00:00:00Z').getTime() / 1000)
    const endTs   = Math.floor(new Date(endDate   + 'T23:59:59Z').getTime() / 1000)
    const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')
    if (isPG) {
      const { query: pgQuery } = require('./pg_connector')
      const result = await pgQuery(
        `SELECT COUNT(*) as cnt FROM matches WHERE COALESCE("startTimestamp", SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint) >= $1 AND COALESCE("startTimestamp", SUBSTRING("fullData" FROM '"startTimestamp":([0-9]+)')::bigint) <= $2 AND status = 'scheduled'`,
        [startTs, endTs]
      )
      return parseInt(result.rows?.[0]?.cnt || '0')
    }
    const row = await db.prepare(
      `SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp <= ? AND status = 'scheduled'`
    ).get(startTs, endTs)
    return row?.cnt || 0
  } catch (e) {
    return 0
  }
}

async function purgeFakeMatches() {
  const db = database.db
  if (!db) return 0
  try {
    let result
    if (db.pragma) {
      result = db.prepare(`DELETE FROM matches WHERE "homeTeam" IS NULL OR "homeTeam" = '' OR "homeTeam" = 'null' OR league = 'FIFA'`).run()
    } else {
      result = await db.prepare(`DELETE FROM matches WHERE "homeTeam" IS NULL OR "homeTeam" = '' OR "homeTeam" = 'null' OR league = 'FIFA'`).run()
    }
    const removed = result.changes || result.rowCount || 0
    if (removed > 0) logger.info(`[CLOUD-SEED/PURGE] Removed ${removed} fake/empty/FIFA matches`)
    return removed
  } catch (e) {
    logger.warn(`[CLOUD-SEED/PURGE] Error: ${e.message}`)
  }
  return 0
}

async function runCloudSeed() {
  const localDataUrl = process.env.LOCAL_DATA_URL || ''
  const isPG = process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgres')

  await purgeFakeMatches()

  // Skip if DB already has enough REAL matches (local mode or already seeded)
  if (!isPG && !localDataUrl) {
    try {
      const db = database.db
      const count = db.prepare('SELECT COUNT(*) as cnt FROM matches WHERE "homeTeam" IS NOT NULL AND "homeTeam" != \'\'').get()
      if (count && count.cnt >= 100) {
        logger.info(`[CLOUD-SEED] DB already has ${count.cnt} real matches — skipping seed`)
        return
      }
    } catch (_) {}
  }

  if (localDataUrl) {
    logger.info('[CLOUD-SEED] LOCAL_DATA_URL detected — using ngrok tunnel as ONLY source. All external APIs SKIPPED.')
    try {
      const { data } = await axios.get(`${localDataUrl}/api/local/matches`, { timeout: 20000 })
      if (!data?.success || !Array.isArray(data.matches)) {
        logger.warn('[CLOUD-SEED/LOCAL] Invalid response from local server')
        return
      }
      const matches = data.matches
      logger.info(`[CLOUD-SEED/LOCAL] ${matches.length} matches fetched from localhost via ngrok`)
      let inserted = 0
      for (const match of matches) {
        if (await upsertMatch(match)) inserted++
      }
      logger.info(`[CLOUD-SEED/LOCAL] Inserted ${inserted}/${matches.length} matches`)
    } catch (e) {
      logger.warn(`[CLOUD-SEED/LOCAL] Error: ${e.message}`)
    }
    return
  }

  logger.info('[CLOUD-SEED] Starting multi-source seeding (Sofascore → FootballData → BSD → TheRundown → OddsPapi → Sportmonks → APIFootball → OpenLigaDB)...')

  const today = getDateStr(0)
  const existingToday = await countMatchesForPeriod(0, 0)
  const existingTomorrow = await countMatchesForPeriod(1, 1)
  logger.info(`[CLOUD-SEED] Existing: ${existingToday} today / ${existingTomorrow} tomorrow`)

  let fdInserted = 0
  let rapidApiInserted = 0
  let sofascoreInserted = 0

  if (process.env.DISABLE_SOFASCORE === 'true') {
    logger.info('[CLOUD-SEED/SOFASCORE] Skipped — DISABLE_SOFASCORE is set.')
  } else {
    logger.info('[CLOUD-SEED/SOFASCORE] Seeding from free public API...')
    try {
      const datesToFetch = [today, getDateStr(1), getDateStr(2), getDateStr(3), getDateStr(4), getDateStr(5), getDateStr(6)]
      const results = await Promise.allSettled(datesToFetch.map(dateStr => fetchSofascoreEvents(dateStr)))
      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === 'rejected') {
          logger.warn(`[CLOUD-SEED/SOFASCORE] ${datesToFetch[i]} failed: ${result.reason?.message || result.reason}`)
          continue
        }
        const events = result.value || []
        const notstarted = events.filter(e => (e.status?.type || '').toLowerCase() === 'notstarted')
        for (const event of notstarted) {
          const match = mapSofascoreEventToMatch(event)
          if (!match) continue
          if (await upsertMatch(match)) sofascoreInserted++
        }
      }
      logger.info(`[CLOUD-SEED/SOFASCORE] Inserted ${sofascoreInserted} free matches total.`)
      if (sofascoreInserted > 0) {
        logger.info('[CLOUD-SEED/SOFASCORE] Fetching SofaScore odds...')
        try {
          const { data: oddsData } = await axios.get(`${SOFASCORE_BASE}/sport/football/scheduled-events/${today}/odds/1x2`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'application/json',
              'Origin': 'https://www.sofascore.com',
              'Referer': 'https://www.sofascore.com/',
            },
            timeout: 20000
          })
          if (oddsData?.data && Array.isArray(oddsData.data)) {
            const db = database.db
            let updated = 0
            for (const odd of oddsData.data) {
              if (!odd.id || !odd.homeOdds) continue
              try {
                const result = db.prepare(`
                  UPDATE matches SET odds_home = ?, odds_draw = ?, odds_away = ?
                  WHERE id = ? AND odds_home IS NULL
                `).run(odd.homeOdds, odd.drawOdds, odd.awayOdds, `sofascore_${odd.id}`)
                if (result.changes > 0) updated++
              } catch (_) {}
            }
            logger.info(`[CLOUD-SEED/SOFASCORE] Updated odds for ${updated} matches`)
          }
        } catch (oddsErr) {
          logger.warn(`[CLOUD-SEED/SOFASCORE] Odds not available: ${oddsErr.message}`)
        }
      }
    } catch (e) {
      logger.warn(`[CLOUD-SEED/SOFASCORE] Error: ${e.message}`)
    }
  }

  let fdQuotaStatus = fdQuotaManager.getQuotaStatus()
  if (existingToday < 20 && fdQuotaStatus.isActive && fdQuotaStatus.remaining > 0) {
    const fixtures = await fetchFDFixtures('/fixtures/upcoming')
    const filtered = fixtures.filter(f => {
      const d = (f.match_date || f.date || '').substring(0, 10)
      return d === today || d === getDateStr(1)
    })
    for (const f of filtered) {
      fdQuotaStatus = fdQuotaManager.getQuotaStatus()
      if (fdQuotaStatus.remaining <= 0) break
      const fdId = f.match_id || f.id
      if (!fdId || !fdQuotaManager.canProcessMatch(fdId)) continue
      if (await upsertMatch(mapFDFixtureToMatch(f))) {
        fdQuotaManager.registerMatch(fdId)
        fdInserted++
      }
    }
    logger.info(`[CLOUD-SEED/FD] Inserted ${fdInserted} primary matches.`)
  }

  try {
    if (bsdService.isAvailable()) {
      try {
        const bsdCount = await bsdService.fullSync()
        const enriched = await bsdService.enrichAllMatchesOdds()
        logger.info(`[CLOUD-SEED/BSD] Inserted ${bsdCount} matches, enriched ${enriched}`)
      } catch (bsdErr) {
        logger.warn(`[CLOUD-SEED/BSD] Error: ${bsdErr.message}`)
      }
    }
  } catch (outerErr) {
    logger.warn(`[CLOUD-SEED/BSD] Outer error: ${outerErr.message}`)
  }

  const fbFallbackSources = [
    { name: 'Sofascore', fetch: () => fetchSofascoreEvents(today).then(events => events.map(mapSofascoreEventToMatch)), available: () => true },
    { name: 'TheRundown', fetch: () => therundownService.fetchSoccerEvents(today).then(events => events.map(e => therundownService.mapEventToMatch(e))), available: () => therundownService.isAvailable() },
    { name: 'OddsPapi',   fetch: () => oddspapiService.fetchEvents(today),              available: () => oddspapiService.isAvailable() },
    { name: 'Sportmonks', fetch: () => sportmonksService.fetchEvents(today),            available: () => sportmonksService.isAvailable() },
    { name: 'APIFootball',fetch: () => apifootballService.fetchEvents(today),           available: () => apifootballService.isAvailable() },
    { name: 'OpenLigaDB', fetch: () => openligadbService.fetchEvents(today),            available: () => openligadbService.isAvailable() },
  ]

  const currentCount = await countMatchesForPeriod(0, 0)
  if (currentCount < 20) {
    for (const src of fbFallbackSources) {
      if (!src.available()) continue
      if (await countMatchesForPeriod(0, 0) >= 20) break
      try {
        const matches = await src.fetch()
        if (!matches?.length) continue
        let inserted = 0
        for (const match of matches) {
          if (match.status !== 'scheduled') continue
          if (await upsertMatch(match)) inserted++
        }
        logger.info(`[CLOUD-SEED/FALLBACK] ${src.name}: inserted ${inserted}/${matches.length} matches`)
        await sleep(500)
      } catch (e) {
        logger.warn(`[CLOUD-SEED/FALLBACK] ${src.name}: error — ${e.message}`)
      }
    }
  }

  const finalAfterFD = await countMatchesForPeriod(0, 0)
  const fdFinished = fdQuotaManager.getQuotaStatus().remaining <= 0 || fdInserted === 0
  const rapidQuotaStatus = rapidApiQuotaManager.getQuotaStatus()
  const canUseRapid = finalAfterFD < 20 && fdFinished && rapidQuotaStatus.isActive && rapidQuotaStatus.remaining > 0

  if (canUseRapid) {
    const events = await fetchRapidApiEvents(today)
    const tier1 = events.filter(isTier1)
    const others = events.filter(e => !isTier1(e))
    const sorted = [...tier1, ...others]
    let rapidUsed = 0
    for (const event of sorted) {
      if (rapidUsed >= rapidQuotaStatus.remaining) break
      if (!event.id || !event.homeTeam || !event.awayTeam) continue
      if (!rapidApiQuotaManager.canProcessMatch(event.id)) continue
      if (await upsertMatch(mapRapidEventToMatch(event))) {
        rapidApiQuotaManager.registerMatch(event.id)
        rapidUsed++
        rapidApiInserted++
      }
      await sleep(200)
    }
    logger.info(`[CLOUD-SEED/RAPID] Inserted ${rapidApiInserted} fallback matches.`)
  }

  const finalToday = await countMatchesForPeriod(0, 0)
  const finalTomorrow = await countMatchesForPeriod(1, 1)
  logger.info(`[CLOUD-SEED] Complete. Sofascore: ${sofascoreInserted}, FootballData: ${fdInserted}, RapidAPI: ${rapidApiInserted}, DB: ${finalToday} today / ${finalTomorrow} tomorrow.`)

  if (finalToday + finalTomorrow === 0) {
    logger.warn('[CLOUD-SEED] WARNING: No scheduled matches found.')
  }

  // Auto-calibrate league params after seeding (non-blocking)
  try {
    const { calibrate } = require('../services/leagueCalibrator')
    calibrate().catch(e => logger.warn(`[CALIBRATE] Auto-calibration error: ${e.message}`))
  } catch (e) {}

  // 🌱 Emergency seed handled EARLY in server.js (async IIFE before cloud seed starts)
  // so it runs before the 8s early auto-enrich and works on PostgreSQL via database.exec()
}

module.exports = { runCloudSeed, purgeFakeMatches }
