const axios = require('axios')
const fs = require('fs')
const path = require('path')

const BASE_DIR = path.resolve(__dirname, '..')
const CACHE_DIR = path.join(BASE_DIR, 'data')
const CACHE_FILE = path.join(CACHE_DIR, 'api_football_cache.json')
const CACHE_TTL = 60 * 60 * 1000

const API_BASE = 'https://v3.football.api-sports.io'
const API_KEY = process.env.API_FOOTBALL_KEY || ''
const API_HOST = process.env.API_FOOTBALL_HOST || 'v3.football.api-sports.io'

const PRIORITY_LEAGUES = [
  39,   // Premier League
  140,  // La Liga
  135,  // Serie A
  78,   // Bundesliga
  61,   // Ligue 1
]

const SECONDARY_LEAGUES = [
  2,    // Champions League
  3,    // Europa League
  13,   // Copa Libertadores
  129,  // Copa Sudamericana
  88,    // Eredivisie
  94,    // Primeira Liga
  62,    // Ligue 2
  40,    // Championship (ENG)
  45,    // 2. Bundesliga
  144,   // Turkish Super Lig
  98,    // Scottish Premiership
]

const MENA_LEAGUES = [
  203,   // Egyptian Premier League
  307,   // Saudi Pro League
  296,   // UAE Arabian Gulf League
  300,   // Qatar Stars League
  294,   // Kuwait Premier League
  229,   // Bahrain Premier League
  297,   // Oman Professional League
  3831,  // Lebanese Premier League
  1243,  // Syrian Premier League
  410,   // Jordan Pro League
]

const AMERICAS_LEAGUES = [
  253,   // MLS
  71,    // Serie B Brasil
  128,   // Argentina Primera
  109,   // Brazil Serie A
  130,   // Chile Primera
]

const ALL_LEAGUES = [
  ...PRIORITY_LEAGUES,
  ...SECONDARY_LEAGUES,
  ...MENA_LEAGUES,
  ...AMERICAS_LEAGUES,
]

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8')
      const data = JSON.parse(raw)
      const now = Date.now()
      for (const key of Object.keys(data)) {
        if (now - data[key].ts > CACHE_TTL) {
          delete data[key]
        }
      }
      return data
    }
  } catch (e) {}
  return {}
}

function saveCache(cache) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8')
  } catch (e) {
    console.warn('[APIFB] Cache save error:', e.message)
  }
}

let diskCache = null
function getCache() {
  if (!diskCache) {
    diskCache = loadCache()
  }
  return diskCache
}

function isAvailable() {
  return API_KEY && process.env.API_FOOTBALL_ENABLED === 'true'
}

function mapStatus(short) {
  const map = {
    'NS': 'scheduled',
    'LIVE': 'inprogress',
    'FT': 'finished',
    'AET': 'finished',
    'PEN': 'finished',
    'HT': 'inprogress',
    'CANC': 'canceled',
    'POSTP': 'postponed',
    'SUSP': 'postponed',
    'ABD': 'canceled',
    'WO': 'canceled',
    'TBD': 'scheduled',
  }
  // Periodes en direct (1H, 2H, ET, BT, etc.) → inprogress
  if (/^\d+H$/.test(short || '') || /^(ET|BT|P)\b/.test(short || '')) {
    return 'inprogress'
  }
  return map[short] || 'scheduled'
}

function mapEventToMatch(event) {
  const home = event.teams?.home
  const away = event.teams?.away
  const league = event.league
  const fixture = event.fixture

  return {
    id: `apifb_${fixture.id}`,
    homeTeam: home?.name || 'Home',
    awayTeam: away?.name || 'Away',
    league: league?.name || 'Unknown',
    category_name: league?.country || '',
    tournament_name: league?.name || '',
    tournament_id: league?.id || null,
    home_team_id: home?.id || null,
    away_team_id: away?.id || null,
    startTimestamp: fixture?.timestamp || Math.floor(Date.now() / 1000),
    timestamp: fixture?.timestamp
      ? new Date(fixture.timestamp * 1000).toISOString()
      : new Date().toISOString(),
    status: mapStatus(fixture?.status?.short),
    confidence: 50,
    prediction: null,
    verdict: 'PENDING',
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    last_updated: Date.now(),
    insufficient_data: 1,
    source: 'apifootball',
    fullData: JSON.stringify(event),
  }
}

function sortByPriority(matches) {
  return matches.sort((a, b) => {
    const aPriority = PRIORITY_LEAGUES.includes(a.tournament_id) ? 0 : 1
    const bPriority = PRIORITY_LEAGUES.includes(b.tournament_id) ? 0 : 1
    return aPriority - bPriority
  })
}

async function fetch(endpoint) {
  const url = `${API_BASE}${endpoint}`
  const { data } = await axios.get(url, {
    headers: {
      'x-apisports-host': API_HOST,
      'x-apisports-Key': API_KEY,
      'Accept': 'application/json',
    },
    timeout: 15000,
  })
  return data?.response || []
}

async function getFixturesForDate(dateStr) {
  const cache = getCache()

  if (cache[dateStr] && Date.now() - cache[dateStr].ts < CACHE_TTL) {
    console.log(`[APIFB] Cache HIT ${dateStr} (${cache[dateStr].data.length} matches)`)
    return cache[dateStr].data
  }

  console.log(`[APIFB] Cache MISS ${dateStr} — fetching`)
  const events = await fetch(`/fixtures?date=${dateStr}`)
  const filtered = events.filter(ev => ALL_LEAGUES.includes(ev.league?.id))
  const matches = filtered.map(mapEventToMatch)

  cache[dateStr] = { ts: Date.now(), data: matches }
  saveCache(cache)

  return matches
}

async function getFixturesMultiple(dates) {
  console.log(`[APIFB] Fetching ${dates.join(', ')} (parallel)`)

  const results = await Promise.all(
    dates.map(date => getFixturesForDate(date).catch(e => {
      console.warn(`[APIFB] Failed ${date}: ${e.message}`)
      return []
    }))
  )

  let allMatches = results.flat()
  allMatches = sortByPriority(allMatches)
  console.log(`[APIFB] Total: ${allMatches.length} matches`)
  return allMatches
}

function getPastDays(n) {
  const days = []
  for (let i = 1; i <= n; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

async function getHistoricalFixtures(days = 7) {
  const pastDates = getPastDays(days)
  console.log(`[APIFB] Fetching historical: ${pastDates.join(', ')}`)

  const results = await Promise.all(
    pastDates.map(date => getFixturesForDate(date).catch(() => []))
  )

  return results.flat().filter(m => m.status === 'finished')
}

async function fetchFixtures(dates) {
  try {
    return await getFixturesMultiple(dates)
  } catch (e) {
    console.warn(`[APIFB] Error: ${e.message}`)
    return []
  }
}

module.exports = {
  isAvailable,
  fetchFixtures,
  getFixturesForDate,
  getFixturesMultiple,
  getHistoricalFixtures,
  sortByPriority,
  mapStatus,
  mapEventToMatch,
  ALL_LEAGUES,
  PRIORITY_LEAGUES,
}
