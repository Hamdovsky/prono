const path = require('path')
const Database = require('better-sqlite3')
const { Pool } = require('pg')

const BASE = path.resolve(__dirname, '..')
const sqlite = new Database(path.join(BASE, 'data', 'tactical.db'))

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_oy3uDHmnCE8P@ep-wandering-wave-atp6q80z-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  max: 5,
})

function convertVal(col, val, neonDataType) {
  if (val === null || val === undefined) return null
  if (typeof val !== 'number') return val
  // Convert unix millis (13 digits) or seconds (10 digits, 2023-2030 range) to ISO timestamp
  if (neonDataType === 'timestamp with time zone') {
    if (val > 1000000000000) return new Date(val).toISOString()
    if (val > 1600000000 && val < 2000000000) return new Date(val * 1000).toISOString()
  }
  // Convert unix millis to seconds for int4 columns (max 2147483647)
  if (neonDataType === 'integer' && val > 2147483647 && val > 1000000000000) {
    return Math.floor(val / 1000)
  }
  return val
}

async function migrate() {
  const client = await pool.connect()
  try {
    const TABLES = [
      'prediction_history', 'player_stats',
      'team_registry', 'sofascore_matches', 'failure_intelligence',
      'winning_patterns', 'learning_memory', 'learning_rules',
      'league_performance_tracking', 'league_challenger_weights', 'league_weights',
    ]

    for (const tableName of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all()
      if (rows.length === 0) { console.log(`  ${tableName}: 0 rows, skip`); continue }

      const colInfo = await client.query(`
        SELECT column_name, data_type, udt_name FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position
      `, [tableName])

      if (colInfo.rows.length === 0) { console.log(`  ${tableName}: table missing in Neon, skip`); continue }

      // Build column -> data type map for type-aware conversion
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
          console.log(`  ${tableName}: batch ${i} error: ${e.message.slice(0, 100)}`)
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
  console.log('✅ Migration complete!')
}

migrate().catch(e => { console.error('❌', e.message); process.exit(1) })
