const database = require('../core/database')
const logger = require('../core/logger')

const TEAM_LEAGUE_MAP = [
  {
    teams: [
      'Beijing Guoan',
      'Shanghai Shenhua',
      'Shandong Taishan',
      'Tianjin Jinmen Tiger',
      'Chengdu Rongcheng',
      'Henan FC',
      'Shanghai Port',
      'Dalian Yingbo FC',
      'Qingdao West Coast',
      'Zhejiang FC',
      'Shenzhen Peng City',
      'Yunnan Yukun',
      'Qingdao Hainiu',
      'Liaoning Tieren FC',
      'Chongqing Tonglianglong FC',
      'Wuhan Three Towns',
    ],
    league: 'Chinese Super League',
  },
  {
    teams: [
      'Fortaleza',
      'Sport Recife',
      'Juventude',
      'Cuiabá EC',
      'Atlético Goianiense',
      'Ceará',
      'Grêmio',
    ],
    league: 'Brasileirão Série A',
  },
  {
    teams: [
      'Ponte Preta',
      'Criciúma',
      'América Mineiro',
      'Avaí',
      'Goiás',
      'Náutico',
      'Operário-PR',
      'São Bernardo',
      'Clube De Regatas Brasil',
      'Grêmio Novorizontino',
      'Londrina',
      'Vila Nova FC',
      'Athletic Club',
    ],
    league: 'Brasileirão Série B',
  },
  {
    teams: [
      'Gold Coast United',
      'Moreton City Excelsior FC',
      'Queensland Lions FC',
      'Wynnum Wolves FC',
      'Peninsula Power',
      'Olympic FC',
      'Gold Coast Knights',
      'Eastern Suburbs',
      'Brisbane Roar Youth',
      'Rochedale Rovers',
      'Magic United TFA',
      'Brisbane City',
    ],
    league: 'NPL Queensland',
  },
  {
    teams: [
      'HJK',
      'Kuopion Palloseura',
      'Ilves',
      'Inter Turku',
      'SJK',
      'VPS',
      'AC Oulu',
      'FC Lahti',
      'IF Gnistan',
      'IFK Mariehamn',
      'Seinäjoki',
    ],
    league: 'Veikkausliiga',
  },
  { teams: ['FF Jaro', 'Turun Palloseura'], league: 'Ykkönen' },
  {
    teams: [
      'Kawkab Athletic Club Marrakech',
      'Olympique Dcheira',
      'Renaissance Zemamra',
      'MAS de Fès',
      'CODM Meknès',
      'Ittihad Tanger',
      'Union Touarga Sport',
      'Raja Club Athletic',
      'Wydad Casablanca',
      'Fath Union Sport',
      'AS FAR Rabat',
      'Difaâ Hassani El-Jadidi',
      "Hassania d'Agadir",
      'Union Sportive Yacoub El Mansour',
      'Olympic Safi',
      'RS Berkane',
      'Maghreb de Fès',
      'Meknès',
      'Touarga',
      'Dcheira',
      'Zemamra',
      'KACM',
    ],
    league: 'Botola Pro',
  },
  {
    teams: [
      'Charleston Battery',
      'Loudoun United FC',
      'Colorado Springs Switchbacks FC',
      'San Antonio FC',
      'Miami FC',
      'Orange County SC',
      'Monterey Bay FC',
      'Oakland Roots SC',
      'El Paso Locomotive FC',
      'Sacramento Republic FC',
      'New Mexico United',
      'Phoenix Rising FC',
      'FC Tulsa',
      'Las Vegas Lights',
      'Birmingham Legion FC',
      'Pittsburgh Riverhounds SC',
      'Hartford Athletic',
      'Louisville City FC',
      'Memphis 901 FC',
      'Indy Eleven',
      'Detroit City FC',
      'Rhode Island FC',
      'North Carolina FC',
      'Oakland Roots',
      'El Paso Locomotive',
      'Sacramento Republic',
      'Phoenix Rising',
      'Birmingham Legion',
    ],
    league: 'USL Championship',
  },
  {
    teams: [
      'Algeria',
      'Austria',
      'Portugal',
      'Uzbekistan',
      'Panama',
      'Croatia',
      'England',
      'Ghana',
      'Scotland',
      'Brazil',
      'Colombia',
      'Bosnia',
      'Qatar',
      'Switzerland',
      'Canada',
      'Ecuador',
      'Germany',
      'Tunisia',
      'Netherlands',
      'Japan',
      'Sweden',
      'Curaçao',
      'South Africa',
      'South Korea',
      'Senegal',
      'Iraq',
      'Czechia',
      'Mexico',
      'Norway',
      'France',
      'Türkiye',
      'USA',
      'Paraguay',
      'Australia',
      'Uruguay',
      'Spain',
      'Egypt',
      'Iran',
      'Cabo Verde',
      'Saudi Arabia',
      'New Zealand',
      'Belgium',
      'Morocco',
      'Haiti',
      'Jordan',
      'Argentina',
      'DR Congo',
      "Côte d'Ivoire",
      'Ivory Coast',
      'Cape Verde',
      'United States',
      'Czech Republic',
      'Turkey',
      'Bosnia & Herzegovina',
      'Congo DR',
    ],
    league: 'FIFA World Cup',
  },
]

function teamsMatch(dbName, mapName) {
  const db = dbName.toLowerCase().trim()
  const map = mapName.toLowerCase().trim()
  if (db === map) return true
  const dbWords = db.split(/\s+/)
  const mapWords = map.split(/\s+/)
  if (mapWords.length === 1) {
    if (map.length <= 5) return false
    return dbWords[0] === map || dbWords[dbWords.length - 1] === map
  }
  const phrase = map.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp('(?:^|\\s)' + phrase + '(?:$|\\s)', 'i')
  return regex.test(db)
}

function findLeagueForMatch(homeTeam, awayTeam) {
  const scores = {}
  for (const entry of TEAM_LEAGUE_MAP) {
    let score = 0
    if (entry.teams.some((t) => teamsMatch(homeTeam, t))) score++
    if (entry.teams.some((t) => teamsMatch(awayTeam, t))) score++
    if (score > 0) scores[entry.league] = score
  }
  if (Object.keys(scores).length === 0) return null
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
  return best[0]
}

async function backfillLeagues() {
  console.log('\n📋 [BACKFILL LEAGUES] Starting...')

  const unknown = await database
    .prepare(
      `
    SELECT id, "homeTeam", "awayTeam", league
    FROM matches
    WHERE league IS NULL OR league = '' OR league = 'Unknown'
  `
    )
    .all()

  console.log(`📡 Found ${unknown.length} still unknown.`)

  let updated = 0
  let skipped = 0

  for (const m of unknown) {
    let league = null
    if (
      m.homeTeam === '2A' ||
      m.awayTeam === '2B' ||
      m.homeTeam.startsWith('test') ||
      m.id.startsWith('test_') ||
      m.id.startsWith('manual_')
    ) {
      league = 'Test Match'
    } else {
      league = findLeagueForMatch(m.homeTeam, m.awayTeam)
    }
    if (league) {
      await database
        .prepare(
          `
        UPDATE matches SET league = ?, "tournament_name" = ? WHERE id = ?
      `
        )
        .run(league, league, m.id)
      logger.info(`✅ ${m.homeTeam} vs ${m.awayTeam} → ${league}`)
      updated++
    } else {
      logger.warn(`⚠️ ${m.homeTeam} vs ${m.awayTeam} — no league mapping found`)
      skipped++
    }
  }

  console.log(`\n✅ [BACKFILL LEAGUES] Done. Updated: ${updated}, Skipped: ${skipped}`)
  return { updated, skipped }
}

if (require.main === module) {
  backfillLeagues()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[BACKFILL LEAGUES] Fatal:', e)
      process.exit(1)
    })
}

module.exports = { backfillLeagues, TEAM_LEAGUE_MAP }
