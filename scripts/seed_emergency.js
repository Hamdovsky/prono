const MATCHES = [
  ['Real Madrid', 'Barcelona', 'LaLiga', 'scheduled', '1', 55, 24, 21, '2 - 1', 58, 62, 82, 1.80, 3.40, 4.50, 4, 30],
  ['Manchester City', 'Arsenal', 'Premier League', 'scheduled', '1', 48, 28, 24, '2 - 1', 55, 58, 78, 1.95, 3.50, 3.80, 5, 35],
  ['Bayern Munich', 'Borussia Dortmund', 'Bundesliga', 'scheduled', '1', 52, 26, 22, '2 - 1', 60, 55, 80, 1.70, 4.00, 4.20, 6, 25],
  ['PSG', 'Marseille', 'Ligue 1', 'scheduled', '1', 50, 28, 22, '2 - 1', 55, 52, 76, 1.85, 3.60, 4.00, 7, 30],
  ['Juventus', 'AC Milan', 'Serie A', 'scheduled', 'X', 34, 40, 26, '1 - 1', 42, 48, 72, 2.40, 3.20, 3.10, 3, 35],
  ['Liverpool', 'Chelsea', 'Premier League', 'scheduled', '1', 46, 30, 24, '2 - 1', 52, 55, 74, 2.00, 3.40, 3.70, 28, 30],
  ['Inter Milan', 'Napoli', 'Serie A', 'scheduled', 'X', 33, 38, 29, '1 - 1', 40, 45, 70, 2.50, 3.15, 2.95, 30, 40],
  ['Barcelona', 'Atletico Madrid', 'LaLiga', 'scheduled', '1', 47, 28, 25, '2 - 1', 50, 52, 75, 1.90, 3.50, 4.00, 29, 30],
  ['Ajax', 'Feyenoord', 'Eredivisie', 'scheduled', '1', 44, 28, 28, '2 - 1', 55, 50, 71, 2.10, 3.50, 3.30, 31, 35],
  ['Benfica', 'Porto', 'Liga Portugal', 'scheduled', 'X', 35, 38, 27, '1 - 1', 42, 46, 69, 2.45, 3.20, 3.00, 32, 40],
  ['Lyon', 'Lille', 'Ligue 1', 'live', '1', 52, 25, 23, '2 - 1', 62, 65, 79, 1.75, 3.80, 4.50, -1, 25],
  ['Roma', 'Lazio', 'Serie A', 'live', 'X', 32, 42, 26, '1 - 1', 35, 40, 73, 2.60, 3.10, 2.85, -2, 45],
  ['Monaco', 'Rennes', 'Ligue 1', 'FT', '1', 55, 24, 21, '2 - 0', 55, 48, 85, 1.85, 3.60, 3.90, -12, 20],
]

const HOUR = 3600

function buildMatch(row) {
  const [home, away, league, status, prediction, hP, dP, aP, expected, ou25, btts, conf, oH, oD, oA, offsetHours, chaos] = row
  const now = Math.floor(Date.now() / 1000)
  const ts = now + offsetHours * HOUR
  return {
    id: `seed_${home.replace(/\s/g,'')}_${away.replace(/\s/g,'')}_${Date.now()}`,
    homeTeam: home,
    awayTeam: away,
    league,
    status,
    scoreHome: 0,
    scoreAway: 0,
    prediction,
    confidence: conf,
    home_win_probability: hP,
    draw_probability: dP,
    away_win_probability: aP,
    expected_score: expected,
    ou_25_prob: ou25,
    btts_prob: btts,
    xgboost_confidence: conf / 100,
    odds_home: oH,
    odds_draw: oD,
    odds_away: oA,
    startTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    source: 'seed',
    chaos_score: chaos || 50,
    insufficient_data: 1,
    last_updated: Date.now(),
  }
}

async function seedDemoMatches(database) {
  let count = 0
  const matches = MATCHES.map(buildMatch)
  if (database.db) {
    const insert = database.db.prepare(`
      INSERT OR REPLACE INTO matches
      (id, homeTeam, awayTeam, league, status, prediction, confidence,
       home_win_probability, draw_probability, away_win_probability,
       expected_score, ou_25_prob, btts_prob, xgboost_confidence,
       odds_home, odds_draw, odds_away, startTimestamp, timestamp, source,
       chaos_score, insufficient_data, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const m of matches) {
      const result = insert.run(m.id, m.homeTeam, m.awayTeam, m.league, m.status, m.prediction, m.confidence,
        m.home_win_probability, m.draw_probability, m.away_win_probability,
        m.expected_score, m.ou_25_prob, m.btts_prob, m.xgboost_confidence,
        m.odds_home, m.odds_draw, m.odds_away, m.startTimestamp, m.timestamp, m.source,
        m.chaos_score, m.insufficient_data, m.last_updated)
      if (result && typeof result.then === 'function') await result
      count++
    }
  } else {
    for (const m of matches) {
      try { await database.insertMatch(m); count++ } catch (_) {}
    }
  }
  return count
}

if (require.main === module) {
  const path = require('path')
  const fs = require('fs')
  const dbPath = path.resolve(__dirname, '..', 'data', 'tactical.db')
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath)
    console.log('Deleted old tactical.db')
  }
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, homeTeam TEXT, awayTeam TEXT, league TEXT,
      scoreHome INTEGER DEFAULT 0, scoreAway INTEGER DEFAULT 0, minute TEXT,
      status TEXT, prediction TEXT, confidence REAL, fullData TEXT,
      timestamp TEXT, startTimestamp INTEGER, source TEXT, last_updated INTEGER,
      home_win_probability REAL, draw_probability REAL, away_win_probability REAL,
      expected_score TEXT, chaos_score INTEGER, ou_25_prob REAL, btts_prob REAL,
      xgboost_confidence REAL, odds_home REAL, odds_draw REAL, odds_away REAL
    )
  `)
  const insert = db.prepare(`
    INSERT OR REPLACE INTO matches
    (id, homeTeam, awayTeam, league, status, prediction, confidence,
     home_win_probability, draw_probability, away_win_probability,
     expected_score, ou_25_prob, btts_prob, xgboost_confidence,
     odds_home, odds_draw, odds_away, startTimestamp, timestamp, source,
     chaos_score, insufficient_data, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const matches = MATCHES.map(buildMatch)
  for (const m of matches) {
    insert.run(m.id, m.homeTeam, m.awayTeam, m.league, m.status, m.prediction, m.confidence,
      m.home_win_probability, m.draw_probability, m.away_win_probability,
      m.expected_score, m.ou_25_prob, m.btts_prob, m.xgboost_confidence,
      m.odds_home, m.odds_draw, m.odds_away, m.startTimestamp, m.timestamp, m.source,
      m.chaos_score, m.insufficient_data, m.last_updated)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp)')
  console.log(`Seeded ${matches.length} matches`)
  db.close()
}

module.exports = { seedDemoMatches }