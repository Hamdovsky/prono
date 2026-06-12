const database = require('../core/database')
const logger = require('../core/logger')

async function main() {
  logger.info('=== PG Column Checker ===')
  
  // Test 1: simple SELECT *
  const r1 = await database.db?.prepare("SELECT * FROM matches LIMIT 3").all()
  logger.info(`SELECT * (rows=${r1?.length || 0}): ${JSON.stringify(r1)}`)

  // Test 2: SELECT id only
  const r2 = await database.db?.prepare("SELECT id FROM matches LIMIT 3").all()
  logger.info(`SELECT id (rows=${r2?.length || 0}): ${JSON.stringify(r2)}`)

  // Test 3: SELECT hometeam (lowercase)
  const r3 = await database.db?.prepare("SELECT hometeam FROM matches LIMIT 3").all()
  logger.info(`SELECT hometeam (rows=${r3?.length || 0}): ${JSON.stringify(r3)}`)

  // Test 4: SELECT homeTeam (camelCase)
  const r4 = await database.db?.prepare("SELECT homeTeam FROM matches LIMIT 3").all()
  logger.info(`SELECT homeTeam (rows=${r4?.length || 0}): ${JSON.stringify(r4)}`)

  // Test 5: describe table
  try {
    const r5 = await database.db?.prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'matches'").all()
    logger.info(`columns: ${JSON.stringify(r5)}`)
  } catch(e) { logger.error(`info_schema: ${e.message}`) }

  // Test 6: getMatchesByStatuses
  const r6 = await database.getMatchesByStatuses(['scheduled'])
  logger.info(`getMatchesByStatuses (rows=${r6.length}): ${JSON.stringify(r6.slice(0,2))}`)

  // Test 7: count with explicit WHERE
  const r7 = await database.db?.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'scheduled'").get()
  logger.info(`count scheduled: ${JSON.stringify(r7)}`)

  logger.info('=== Done ===')
}

main().catch(e => logger.error(`Main error: ${e.message}`))
