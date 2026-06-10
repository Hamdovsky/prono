require('dotenv').config()
const sportdb = require('../services/sportdbService')
const path = require('path')
const Database = require('better-sqlite3')
const logger = console

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')

function getCount() {
  try {
    const db = new Database(ARCHIVE_PATH, { readonly: true })
    const c = db.prepare('SELECT COUNT(*) as c FROM archive_matches').get().c
    db.close()
    return c
  } catch { return 0 }
}

async function main() {
  const maxPages = parseInt(process.argv[2]) || 3

  logger.info('========================================')
  logger.info('  SPORTDB Historical Data Import')
  logger.info(`  Max pages per season: ${maxPages}`)
  logger.info('========================================')

  const before = getCount()
  logger.info(`Matches before import: ${before}`)

  const total = await sportdb.importAllMajorLeagues(maxPages)

  const after = getCount()
  logger.info(`Matches after import: ${after}`)
  logger.info(`New matches added: ${after - before}`)
  logger.info('========================================')
  logger.info('  Import complete!')
  logger.info('========================================')
}

main().catch(e => {
  logger.error('Fatal error:', e.message)
  process.exit(1)
})
