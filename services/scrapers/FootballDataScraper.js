/**
 * FootballDataScraper — Scrapes CSV odds from football-data.co.uk
 *
 * 100% gratuit, pas de scraping, juste des fichiers CSV publics.
 * Couverture: ~50 ligues (Angleterre, Europe, Monde)
 *
 * Role: Enrichir les cotes pre-match avec les données de plusieurs bookmakers
 *
 * Usage:
 *   const fd = require('./FootballDataScraper')
 *   const odds = await fd.getOddsForLeague('E0')  // Premier League
 */

const https = require('https')
const fs = require('fs')
const path = require('path')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const CACHE_DIR = path.join(BASE_DIR, 'data', 'football_data')
const CACHE_TTL = 6 * 60 * 60 * 1000

const LEAGUE_CODES = {
  E0: 'england/premier-league',
  E1: 'england/championship',
  E2: 'england/league-one',
  E3: 'england/league-two',
  EC: 'england/national-league',
  D1: 'germany/bundesliga',
  D2: 'germany/2-bundesliga',
  I1: 'italy/serie-a',
  I2: 'italy/serie-b',
  SP1: 'spain/la-liga',
  SP2: 'spain/segunda-division',
  F1: 'france/ligue-1',
  F2: 'france/ligue-2',
  N1: 'netherlands/eredivisie',
  P1: 'portugal/primeira-liga',
  T1: 'turkey/super-lig',
  G1: 'greece/super-league',
  R1: 'russia/premier-liga',
  BEL1: 'belgium/jupiler-pro-league',
  SCO0: 'scotland/premiership',
  SCO1: 'scotland/championship',
  A1: 'austria/bundesliga',
  CH1: 'switzerland/super-league',
  UKR1: 'ukraine/premier-liga',
  CZE1: 'czech-republic/1-liga',
  RO1: 'romania/liga-i',
  B1: 'brazil/serie-a',
  B2: 'brazil/serie-b',
  ARA: 'argentina/primera-division',
  MLS: 'usa/us-major-league-soccer',
}

const CSV_URLS = {
  E0: 'https://www.football-data.co.uk/mmz4281/2627/E0.csv',
  E1: 'https://www.football-data.co.uk/mmz4281/2627/E1.csv',
  E2: 'https://www.football-data.co.uk/mmz4281/2627/E2.csv',
  D1: 'https://www.football-data.co.uk/mmz4281/2627/D1.csv',
  I1: 'https://www.football-data.co.uk/mmz4281/2627/I1.csv',
  SP1: 'https://www.football-data.co.uk/mmz4281/2627/SP1.csv',
  F1: 'https://www.football-data.co.uk/mmz4281/2627/F1.csv',
  N1: 'https://www.football-data.co.uk/mmz4281/2627/N1.csv',
  P1: 'https://www.football-data.co.uk/mmz4281/2627/P1.csv',
  B1: 'https://www.football-data.co.uk/mmz4281/2627/B1.csv',
}

const cache = new Map()

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

function parseDate(dateStr) {
  const parts = dateStr.split('/')
  if (parts.length !== 3) return null
  const [day, mon, year] = parts
  const fullYear = year.length === 2 ? '20' + year : year
  return new Date(`${fullYear}-${mon}-${day}`)
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map((h) => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',')
    if (values.length < headers.length) continue
    const row = {}
    headers.forEach((h, idx) => {
      row[h.trim()] = values[idx] ? values[idx].trim() : ''
    })
    rows.push(row)
  }
  return rows
}

function fetchCsv(url, leagueCode) {
  return new Promise((resolve, reject) => {
    const cacheKey = leagueCode
    if (cache.has(cacheKey)) {
      const { data, ts } = cache.get(cacheKey)
      if (Date.now() - ts < CACHE_TTL) {
        return resolve(data)
      }
    }

    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const parsed = parseCsv(data)
            cache.set(cacheKey, { data: parsed, ts: Date.now() })
            ensureCacheDir()
            const cacheFile = path.join(CACHE_DIR, `${leagueCode}.json`)
            fs.writeFileSync(cacheFile, JSON.stringify(parsed), 'utf8')
            resolve(parsed)
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function getOddsForLeague(leagueCode) {
  const url = CSV_URLS[leagueCode]
  if (!url) return []
  try {
    return await fetchCsv(url, leagueCode)
  } catch (e) {
    console.error(`[FootballData] Error fetching ${leagueCode}: ${e.message}`)
    return []
  }
}

async function getOddsForMatch(homeTeam, awayTeam, leagueCode) {
  const rows = await getOddsForLeague(leagueCode)
  if (!rows.length) return null

  const homeL = homeTeam.toLowerCase()
  const awayL = awayTeam.toLowerCase()

  const match = rows.find((r) => {
    const rHome = (r.HomeTeam || '').toLowerCase()
    const rAway = (r.AwayTeam || '').toLowerCase()
    return (rHome.includes(homeL) || homeL.includes(rHome)) &&
      (rAway.includes(awayL) || awayL.includes(rAway))
  })

  if (!match) return null

  const avgH = parseFloat(match.AvgH) || null
  const avgD = parseFloat(match.AvgD) || null
  const avgA = parseFloat(match.AvgA) || null
  const avgOver = parseFloat(match['Avg>2.5']) || null
  const avgUnder = parseFloat(match['Avg<2.5']) || null
  const b365H = parseFloat(match.B365H) || null
  const b365A = parseFloat(match.B365A) || null

  return {
    home: avgH,
    draw: avgD,
    away: avgA,
    over25: avgOver,
    under25: avgUnder,
    bookmaker: 'Avg (multiple)',
    b365_home: b365H,
    b365_away: b365A,
    date: match.Date,
    homeTeam: match.HomeTeam,
    awayTeam: match.AwayTeam,
    ftScore: `${match.FTHG}-${match.FTAG}`,
    source: 'football-data.co.uk',
  }
}

async function getAllLeaguesOdds() {
  const results = {}
  for (const code of Object.keys(CSV_URLS)) {
    const data = await getOddsForLeague(code)
    if (data.length > 0) {
      results[code] = data
      console.log(`[FootballData] ${code}: ${data.length} matches`)
    }
  }
  return results
}

function getLeagueName(code) {
  const names = {
    E0: 'Premier League',
    E1: 'Championship',
    E2: 'League One',
    D1: 'Bundesliga',
    I1: 'Serie A',
    SP1: 'La Liga',
    F1: 'Ligue 1',
    N1: 'Eredivisie',
    P1: 'Primeira Liga',
    B1: 'Serie A Brasil',
  }
  return names[code] || code
}

module.exports = {
  getOddsForLeague,
  getOddsForMatch,
  getAllLeaguesOdds,
  getLeagueName,
  LEAGUE_CODES,
  CSV_URLS,
}
