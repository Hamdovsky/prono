// @ts-nocheck
import Database from 'better-sqlite3'
import path from 'path'

const dbPath = path.join(__dirname, '..', 'data', 'tactical.db')
const db = new Database(dbPath)

console.log('=== TABLES ===')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log(tables.map((t) => t.name).join('\n'))

console.log('\n=== MATCHES TABLE SCHEMA ===')
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='matches'").get()
console.log(schema ? schema.sql : 'NO matches TABLE FOUND')

console.log('\n=== ALL COLUMNS OF matches ===')
const cols = db.prepare('PRAGMA table_info(matches)').all()
console.log(cols.map((c) => `${c.name} (${c.type}${c.notnull ? ' NOT NULL' : ''})`).join('\n'))

console.log('\n=== SAMPLE ROWS (first 3) ===')
const sample = db.prepare('SELECT * FROM matches LIMIT 3').all()
sample.forEach((row, i) => {
  console.log(`\n--- Row ${i + 1} ---`)
  for (const [k, v] of Object.entries(row)) {
    const val = typeof v === 'string' && v.length > 200 ? v.substring(0, 200) + '...' : v
    console.log(`  ${k}: ${val}`)
  }
})

console.log('\n=== COUNT ===')
const count = db.prepare('SELECT COUNT(*) as cnt FROM matches').get()
console.log('Total matches:', count.cnt)

console.log('\n=== DISTINCT stat columns check ===')
const statCols = [
  'teamStats',
  'form_context',
  'h2h_data',
  'stats_blob',
  'news_data',
  'statistics',
  'form',
  'h2h',
  'stats',
]
const existingCols = cols.map((c) => c.name)
for (const sc of statCols) {
  if (existingCols.includes(sc)) {
    const nonNull = db.prepare(`SELECT COUNT(*) as cnt FROM matches WHERE ${sc} IS NOT NULL`).get()
    const sample = db.prepare(`SELECT ${sc} FROM matches WHERE ${sc} IS NOT NULL LIMIT 1`).get()
    console.log(
      `${sc}: ${nonNull.cnt} non-null rows, sample: ${sample ? String(sample[sc]).substring(0, 300) : 'NULL'}`
    )
  }
}

db.close()
