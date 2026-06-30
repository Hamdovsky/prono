const path = require('path')
const Database = require('better-sqlite3')
const { Pool } = require('pg')

const BASE = path.resolve(__dirname, '..')
const sqlite = new Database(path.join(BASE, 'data', 'tactical.db'))

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
})

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL env var required')
  process.exit(1)
}

const CREATE_SQL = {
  sofascore_matches: `CREATE TABLE IF NOT EXISTS sofascore_matches (
    id SERIAL PRIMARY KEY,
    home_team TEXT, away_team TEXT, time TEXT, league TEXT,
    odds_1 REAL, odds_x REAL, odds_2 REAL, source TEXT, scraped_at BIGINT
  )`,
  failure_intelligence: `CREATE TABLE IF NOT EXISTS failure_intelligence (
    id SERIAL PRIMARY KEY,
    failure_type TEXT, league TEXT, team TEXT, referee_id TEXT,
    frequency INTEGER DEFAULT 0, avg_confidence REAL,
    impact_roi REAL DEFAULT 0, impact_clv REAL DEFAULT 0,
    last_detected TEXT,
    UNIQUE(failure_type, league, team)
  )`,
  learning_memory: `CREATE TABLE IF NOT EXISTS learning_memory (
    id SERIAL PRIMARY KEY,
    match_id TEXT NOT NULL, league TEXT NOT NULL,
    home_team TEXT, away_team TEXT, score TEXT,
    prediction TEXT, confidence REAL, actual TEXT,
    error_type TEXT, root_cause TEXT, context TEXT,
    tags TEXT, adjustments TEXT, new_rule TEXT,
    match_date TIMESTAMPTZ, root_causes_stack TEXT,
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(match_id)
  )`,
  learning_rules: `CREATE TABLE IF NOT EXISTS learning_rules (
    id SERIAL PRIMARY KEY,
    league TEXT, rule_type TEXT, condition TEXT, action TEXT,
    confidence REAL, hit_count INTEGER DEFAULT 1,
    last_fired TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(league, rule_type, condition)
  )`,
  league_weights: `CREATE TABLE IF NOT EXISTS league_weights (
    id SERIAL PRIMARY KEY,
    league TEXT NOT NULL UNIQUE, weights TEXT NOT NULL,
    confidence_adj REAL DEFAULT 0.0, total_cases INTEGER DEFAULT 0,
    accuracy REAL DEFAULT 0.5,
    last_updated TIMESTAMPTZ DEFAULT NOW()
  )`,
}

function convertVal(col, val, neonDataType) {
  if (val === null || val === undefined) return null
  if (typeof val !== 'number') return val
  if (neonDataType === 'timestamp with time zone') {
    if (val > 1000000000000) return new Date(val).toISOString()
    if (val > 1600000000 && val < 2000000000) return new Date(val * 1000).toISOString()
  }
  if (neonDataType === 'integer' && val > 2147483647 && val > 1000000000000) {
    return Math.floor(val / 1000)
  }
  return val
}

async function migrate() {
  const client = await pool.connect()
  try {
    for (const [tableName, createSql] of Object.entries(CREATE_SQL)) {
      await client.query(createSql)
      console.log(`Created ${tableName}`)

      const rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all()
      if (rows.length === 0) { console.log(`  ${tableName}: 0 rows, skip`); continue }

      const colInfo = await client.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position
      `, [tableName])

      const colTypeMap = {}
      colInfo.rows.forEach(r => { colTypeMap[r.column_name] = r.data_type })

      const neonCols = colInfo.rows.map(r => r.column_name)
      const sqliteCols = Object.keys(rows[0])
      const commonCols = sqliteCols.filter(c => neonCols.includes(c))
      if (commonCols.length === 0) { console.log(`  ${tableName}: no common cols`); continue }

      const quotedCols = commonCols.map(c => `"${c}"`)
      const BATCH = 200
      let inserted = 0

      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH)
        const params = []
        const valueRows = batch.map((row, ri) => {
          return '(' + commonCols.map((_, ci) => {
            const idx = ri * commonCols.length + ci + 1
            params.push(convertVal(commonCols[ci], row[commonCols[ci]], colTypeMap[commonCols[ci]]))
            return `$${idx}`
          }).join(', ') + ')'
        }).join(', ')

        try {
          await client.query(
            `INSERT INTO "${tableName}" (${quotedCols.join(', ')}) VALUES ${valueRows} ON CONFLICT DO NOTHING`,
            params
          )
          inserted += batch.length
        } catch (e) {
          console.log(`  batch ${i} error: ${e.message.slice(0, 100)}`)
          for (const row of batch) {
            try {
              const vals = commonCols.map((_, ci) => `$${ci + 1}`).join(', ')
              await client.query(
                `INSERT INTO "${tableName}" (${quotedCols.join(', ')}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
                commonCols.map(c => convertVal(c, row[c], colTypeMap[c]))
              )
              inserted++
            } catch (_) {}
          }
        }
        process.stdout.write(`  ${tableName}: ${inserted}/${rows.length}\r`)
      }
      console.log(`\n  ${tableName}: ${inserted}/${rows.length} rows migrated`)
    }
  } finally {
    client.release()
  }
  await pool.end()
  sqlite.close()
  console.log('✅ Done!')
}

migrate().catch(e => { console.error('❌', e.message); process.exit(1) })
