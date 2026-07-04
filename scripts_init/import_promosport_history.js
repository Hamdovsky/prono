const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

async function importHistory() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1
  })

  try {
    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promosport_historical_grids (
        concours TEXT PRIMARY KEY,
        date TEXT,
        matches JSONB NOT NULL,
        imported_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    console.log('✅ Table promosport_historical_grids created/verified')

    // Load historical data
    const historyPath = path.join(__dirname, 'data', 'promosport_historical_results.json')
    const rawData = fs.readFileSync(historyPath, 'utf8')
    const history = JSON.parse(rawData)

    console.log(`📦 Found ${history.length} historical concours to import`)

    // Insert each concours
    let imported = 0
    for (const c of history) {
      try {
        await pool.query(
          `INSERT INTO promosport_historical_grids (concours, date, matches) 
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (concours) DO UPDATE SET 
             date = EXCLUDED.date, 
             matches = EXCLUDED.matches,
             imported_at = NOW()`,
          [c.no, 'historical', JSON.stringify({
            matches: c.matches.map(m => ({
              id: m.idx, home: m.home, away: m.away, result: m.res
            }))
          })]
        )
        imported++
      } catch (e) {
        console.error(`❌ Error importing concours ${c.no}:`, e.message)
      }
    }

    console.log(`✅ Imported ${imported}/${history.length} concours`)

    // Verify
    const res = await pool.query('SELECT COUNT(*) FROM promosport_historical_grids')
    console.log(`📊 Total rows in table: ${res.rows[0].count}`)

  } catch (e) {
    console.error('❌ Error:', e.message)
  } finally {
    await pool.end()
  }
}

importHistory()