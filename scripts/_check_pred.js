const database = require('../core/database')
async function main() {
  const preds = await database.prepare("SELECT DISTINCT prediction FROM matches WHERE prediction IS NOT NULL").all()
  console.log('Prediction values:', preds.map(r => r.prediction).join(', '))
  
  const sample = await database.prepare('SELECT id, prediction, "scoreHome", "scoreAway", "expected_score", confidence, league, "homeTeam", "awayTeam" FROM matches WHERE prediction IS NOT NULL AND "scoreHome" IS NOT NULL LIMIT 5').all()
  console.log('Sample:', JSON.stringify(sample, null, 2))
  
  const count = await database.prepare('SELECT COUNT(*) as c FROM matches WHERE prediction IS NOT NULL AND "scoreHome" IS NOT NULL').get()
  console.log('Matches with both prediction and score:', count.c)
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
