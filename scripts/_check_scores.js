const database = require('../core/database')
async function main() {
  const sample = await database.prepare('SELECT id, prediction, "scoreHome", "scoreAway", league, "homeTeam", "awayTeam", status FROM matches WHERE "scoreHome" > 0 AND prediction IS NOT NULL LIMIT 10').all()
  console.log('Sample real scores:', JSON.stringify(sample, null, 2))
  const count = await database.prepare('SELECT COUNT(*) as c FROM matches WHERE "scoreHome" > 0 AND prediction IS NOT NULL').get()
  console.log('Matches with real score + prediction:', count.c)
  const ftCount = await database.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'FT' AND prediction IS NOT NULL").get()
  console.log('FT + prediction:', ftCount.c)
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
