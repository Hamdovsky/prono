/**
 * seed_emergency.js — Seed de secours pour tactical.db
 * 
 * Peuple la base SQLite avec des matchs de démonstration pour que
 * le dashboard fonctionne même sans APIs externes.
 * 
 * Usage: node scripts/seed_emergency.js
 */

const path = require('path')
const fs = require('fs')

const DB_PATH = path.resolve(__dirname, '..', 'data', 'tactical.db')

// Supprimer l'ancienne base vide pour repartir de zéro
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH)
  console.log('🗑️  Ancienne tactical.db supprimée')
}

const Database = require('better-sqlite3')
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    homeTeam TEXT,
    awayTeam TEXT,
    league TEXT,
    scoreHome INTEGER DEFAULT 0,
    scoreAway INTEGER DEFAULT 0,
    minute TEXT,
    status TEXT,
    prediction TEXT,
    confidence REAL,
    fullData TEXT,
    timestamp TEXT,
    startTimestamp INTEGER,
    source TEXT,
    last_updated INTEGER,
    home_win_probability REAL,
    draw_probability REAL,
    away_win_probability REAL,
    expected_score TEXT,
    chaos_score INTEGER,
    ou_25_prob REAL,
    btts_prob REAL,
    xgboost_confidence REAL,
    odds_home REAL,
    odds_draw REAL,
    odds_away REAL
  )
`)

function seedMatch(home, away, league, status, prediction, homeP, drawP, awayP, expected, ou25, btts, confidence, oddsH, oddsD, oddsA, startTs, chaos) {
  const id = `seed_${home.replace(/\s/g,'')}_${away.replace(/\s/g,'')}_${Date.now()}`
  const ts = startTs || Math.floor(Date.now() / 1000) + 86400
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO matches
    (id, homeTeam, awayTeam, league, status, prediction, confidence,
     home_win_probability, draw_probability, away_win_probability,
     expected_score, ou_25_prob, btts_prob, xgboost_confidence,
     odds_home, odds_draw, odds_away, startTimestamp, timestamp, source,
     chaos_score, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, home, away, league, status, prediction, confidence,
    homeP, drawP, awayP, expected, ou25, btts, confidence / 100,
    oddsH, oddsD, oddsA, ts, new Date(ts * 1000).toISOString(), 'seed',
    chaos || 50, Date.now())
}

const now = Math.floor(Date.now() / 1000)
const HOUR = 3600

// Matchs du jour (aujourd'hui)
seedMatch('Real Madrid', 'Barcelona', 'LaLiga', 'scheduled', '1', 55, 24, 21, '2 - 1', 58, 62, 82, 1.80, 3.40, 4.50, now + 4 * HOUR, 30)
seedMatch('Manchester City', 'Arsenal', 'Premier League', 'scheduled', '1', 48, 28, 24, '2 - 1', 55, 58, 78, 1.95, 3.50, 3.80, now + 5 * HOUR, 35)
seedMatch('Bayern Munich', 'Borussia Dortmund', 'Bundesliga', 'scheduled', '1', 52, 26, 22, '2 - 1', 60, 55, 80, 1.70, 4.00, 4.20, now + 6 * HOUR, 25)
seedMatch('PSG', 'Marseille', 'Ligue 1', 'scheduled', '1', 50, 28, 22, '2 - 1', 55, 52, 76, 1.85, 3.60, 4.00, now + 7 * HOUR, 30)
seedMatch('Juventus', 'AC Milan', 'Serie A', 'scheduled', 'X', 34, 40, 26, '1 - 1', 42, 48, 72, 2.40, 3.20, 3.10, now + 3 * HOUR, 35)

// Matchs de demain
seedMatch('Liverpool', 'Chelsea', 'Premier League', 'scheduled', '1', 46, 30, 24, '2 - 1', 52, 55, 74, 2.00, 3.40, 3.70, now + 28 * HOUR, 30)
seedMatch('Inter Milan', 'Napoli', 'Serie A', 'scheduled', 'X', 33, 38, 29, '1 - 1', 40, 45, 70, 2.50, 3.15, 2.95, now + 30 * HOUR, 40)
seedMatch('Barcelona', 'Atletico Madrid', 'LaLiga', 'scheduled', '1', 47, 28, 25, '2 - 1', 50, 52, 75, 1.90, 3.50, 4.00, now + 29 * HOUR, 30)
seedMatch('Ajax', 'Feyenoord', 'Eredivisie', 'scheduled', '1', 44, 28, 28, '2 - 1', 55, 50, 71, 2.10, 3.50, 3.30, now + 31 * HOUR, 35)
seedMatch('Benfica', 'Porto', 'Liga Portugal', 'scheduled', 'X', 35, 38, 27, '1 - 1', 42, 46, 69, 2.45, 3.20, 3.00, now + 32 * HOUR, 40)

// Matchs live
seedMatch('Lyon', 'Lille', 'Ligue 1', 'live', '1', 52, 25, 23, '2 - 1', 62, 65, 79, 1.75, 3.80, 4.50, now - 1 * HOUR, 25)
seedMatch('Roma', 'Lazio', 'Serie A', 'live', 'X', 32, 42, 26, '1 - 1', 35, 40, 73, 2.60, 3.10, 2.85, now - 2 * HOUR, 45)

// Matchs terminés
seedMatch('Monaco', 'Rennes', 'Ligue 1', 'FT', '1', 55, 24, 21, '2 - 0', 55, 48, 85, 1.85, 3.60, 3.90, now - 12 * HOUR, 20)

// Créer les index
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
  CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);
`)

const count = db.prepare('SELECT COUNT(*) as c FROM matches').get()
console.log(`✅ Base tactical.db créée avec ${count.c} matchs`)
db.close()
