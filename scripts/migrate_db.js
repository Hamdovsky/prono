const path = require('path')
const fs = require('fs')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'core', 'db', 'migrations')
const DB_PATH = path.join(__dirname, '..', 'data', 'tactical.db')

async function runMigrations() {
  const Database = require('better-sqlite3')
  const db = new Database(DB_PATH)

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true })
    console.log(`📁 Created migrations directory: ${MIGRATIONS_DIR}`)
  }

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  )

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
    console.log(`▶️  Applying migration: ${file}`)
    db.exec(sql)
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file)
    count++
  }

  db.close()
  console.log(`✅ ${count} migration(s) applied`)
}

if (require.main === module) {
  runMigrations().catch(err => {
    console.error('❌ Migration failed:', err.message)
    process.exit(1)
  })
}

module.exports = { runMigrations }
