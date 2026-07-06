const path = require('path')
const Database = require('better-sqlite3')
const logger = require('../core/logger')

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const mlService = require('../services/promosportMLService')

function backfillPredictions() {
  const db = new Database(ARCHIVE_PATH)

  // Ensure predictions table exists
  db.prepare(`
    CREATE TABLE IF NOT EXISTS promosport_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concours TEXT NOT NULL,
      date TEXT,
      grid_name TEXT,
      match_idx INTEGER,
      home_team TEXT,
      away_team TEXT,
      choices TEXT,
      created_at DATETIME DEFAULT datetime('now'),
      UNIQUE(concours, grid_name, match_idx)
    )
  `).run()

  // Read all archive matches with results that don't have a prediction yet
  const rows = db.prepare(`
    SELECT pa.concours, pa.match_idx, pa.homeTeam, pa.awayTeam, pa.result,
           pa.vote_home, pa.vote_draw, pa.vote_away, pa.score_home, pa.score_away,
           pa.archived_at
    FROM promosport_archive pa
    WHERE pa.result IS NOT NULL AND pa.result != 'N'
    ORDER BY pa.archived_at ASC
  `).all()
  db.close()

  if (rows.length === 0) {
    logger.info('[BACKFILL] No archive matches with results found')
    return { total: 0, stored: 0 }
  }

  logger.info(`[BACKFILL] Processing ${rows.length} archive matches...`)

  // Group by concours so we can batch-predict per concours
  const byConcours = {}
  for (const r of rows) {
    if (!byConcours[r.concours]) byConcours[r.concours] = []
    byConcours[r.concours].push(r)
  }

  let totalStored = 0
  const concoursNumbers = Object.keys(byConcours)

  for (const cno of concoursNumbers) {
    const matches = byConcours[cno]

    // Map archive rows to match objects expected by _extractFeatures
    const matchObjects = matches.map(m => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      publicP1: m.vote_home,
      publicPX: m.vote_draw,
      publicP2: m.vote_away,
      homeWinProbability: m.vote_home,
      drawProbability: m.vote_draw,
      awayWinProbability: m.vote_away
    }))

    const predictions = mlService.predictBatch(matchObjects)
    if (!predictions) {
      logger.warn(`[BACKFILL] ML model unavailable, skipping concours ${cno}`)
      continue
    }

    // Open predictions DB for storing
    const pdb = new Database(ARCHIVE_PATH)
    const upsert = pdb.prepare(`
      INSERT OR REPLACE INTO promosport_predictions
        (concours, date, grid_name, match_idx, home_team, away_team, choices, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    const dateStr = new Date().toISOString().slice(0, 10)

    const tx = pdb.transaction(() => {
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i]
        const p = predictions[i]
        if (!p) continue

        // Pick most confident outcome
        const probs = [
          { label: '1', prob: p.p1 },
          { label: 'X', prob: p.px },
          { label: '2', prob: p.p2 }
        ]
        probs.sort((a, b) => b.prob - a.prob)
        const choices = probs.slice(0, 1).map(c => c.label)

        upsert.run(
          String(cno),
          dateStr,
          'ML_MODEL',
          m.match_idx,
          m.homeTeam,
          m.awayTeam,
          JSON.stringify(choices)
        )
        totalStored++
      }
    })
    tx()
    pdb.close()
  }

  logger.info(`[BACKFILL] Done — stored ${totalStored} predictions for ${concoursNumbers.length} concours`)
  return { total: rows.length, stored: totalStored, concours: concoursNumbers.length }
}

if (require.main === module) {
  const result = backfillPredictions()
  console.log(JSON.stringify(result))
}

module.exports = { backfillPredictions }
