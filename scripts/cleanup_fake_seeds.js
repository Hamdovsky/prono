/**
 * Cleanup script: reset old seed matches so enrichment can refresh them
 * Run: node scripts/cleanup_fake_seeds.js
 */
const path = require('path')
const database = require('../core/database')

async function cleanup() {
  const db = database.db
  if (!db) {
    console.error('No database connection')
    process.exit(1)
  }

  const count = db
    .prepare(
      `
    UPDATE matches SET
      insufficient_data = 1,
      expected_score = NULL,
      home_win_probability = NULL,
      draw_probability = NULL,
      away_win_probability = NULL,
      btts_prob = NULL,
      ou_25_prob = NULL,
      confidence = 50,
      last_updated = ?
    WHERE source IN ('seed', 'emergency')
  `
    )
    .run(Date.now())

  console.log(`Reset ${count.changes} seed matches — enrichment will refresh them on next cycle`)
  process.exit(0)
}

cleanup()
