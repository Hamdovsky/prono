const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')
const logger = require('./logger')

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'promosport_archive_snapshot.json')

const PREDICTION_TABLES = ['promosport_predictions', 'promosport_archive']

function hasArchiveData(db) {
  try {
    for (const t of PREDICTION_TABLES) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`)
        .get(t)
      if (!row || row.n === 0) return false
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()
      if (!count || count.n === 0) return false
    }
    return true
  } catch (e) {
    return false
  }
}

function restoreFromSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    logger.warn('[PROMOSPORT] No snapshot found — archive will be empty until backfill')
    return { restored: false, reason: 'no-snapshot' }
  }

  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'))
  const predictions = snapshot.promosport_predictions || []
  const archive = snapshot.promosport_archive || []

  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true })
  const db = new Database(ARCHIVE_PATH)

  db.exec(`
    CREATE TABLE IF NOT EXISTS promosport_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concours TEXT NOT NULL,
      date TEXT,
      grid_name TEXT,
      match_idx INTEGER,
      home_team TEXT,
      away_team TEXT,
      choices TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(concours, grid_name, match_idx)
    );
    CREATE TABLE IF NOT EXISTS promosport_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concours TEXT,
      match_idx INTEGER,
      homeTeam TEXT,
      awayTeam TEXT,
      result TEXT,
      score_home INTEGER,
      score_away INTEGER,
      vote_home REAL,
      vote_draw REAL,
      vote_away REAL,
      date TEXT,
      is_finished INTEGER DEFAULT 0,
      archived_at DATETIME
    );
  `)

  const upsertPred = db.prepare(`
    INSERT OR REPLACE INTO promosport_predictions
      (concours, date, grid_name, match_idx, home_team, away_team, choices, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const upsertArch = db.prepare(`
    INSERT OR REPLACE INTO promosport_archive
      (concours, match_idx, homeTeam, awayTeam, result, score_home, score_away,
       vote_home, vote_draw, vote_away, date, is_finished, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const tx = db.transaction(() => {
    for (const p of predictions) {
      upsertPred.run(
        p.concours,
        p.date,
        p.grid_name,
        p.match_idx,
        p.home_team,
        p.away_team,
        p.choices,
        p.created_at
      )
    }
    for (const a of archive) {
      upsertArch.run(
        a.concours,
        a.match_idx,
        a.homeTeam,
        a.awayTeam,
        a.result,
        a.score_home,
        a.score_away,
        a.vote_home,
        a.vote_draw,
        a.vote_away,
        a.date,
        a.is_finished,
        a.archived_at
      )
    }
  })
  tx()

  const nPred = db.prepare('SELECT COUNT(*) AS n FROM promosport_predictions').get().n
  const nArch = db.prepare('SELECT COUNT(*) AS n FROM promosport_archive').get().n
  db.close()

  logger.info(
    `[PROMOSPORT] Archive restored from snapshot: ${nPred} predictions, ${nArch} archive rows`
  )
  return { restored: true, predictions: nPred, archive: nArch }
}

function ensurePromosportArchive() {
  try {
    if (fs.existsSync(ARCHIVE_PATH)) {
      const db = new Database(ARCHIVE_PATH, { readonly: true })
      const ok = hasArchiveData(db)
      db.close()
      if (ok) {
        logger.info('[PROMOSPORT] Archive already populated — no restore needed')
        return { restored: false, reason: 'already-populated' }
      }
    }
    return restoreFromSnapshot()
  } catch (e) {
    logger.warn(`[PROMOSPORT] Archive ensure failed: ${e.message}`)
    return { restored: false, reason: 'error', error: e.message }
  }
}

module.exports = { ensurePromosportArchive }
