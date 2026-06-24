const database = require('../core/database')
async function main() {
  const r1 = await database.prepare('SELECT COUNT(*) as c FROM matches WHERE "home_win_probability" IS NOT NULL AND "scoreHome" > 0').get()
  const r2 = await database.prepare('SELECT COUNT(*) as c FROM matches WHERE "home_win_probability" IS NOT NULL AND "scoreHome" IS NOT NULL').get()
  const r3 = await database.prepare('SELECT COUNT(*) as c FROM matches WHERE "scoreHome" > 0').get()
  const r4 = await database.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'FT'").get()
  console.log('Probs+realScore:', r1.c, '| Probs+anyScore:', r2.c, '| RealScore>0:', r3.c, '| FT:', r4.c)

  const sample = await database.prepare('SELECT id, "homeTeam", "awayTeam", prediction, "expected_score", "scoreHome", "scoreAway", "home_win_probability", "draw_probability", "away_win_probability" FROM matches WHERE "home_win_probability" IS NOT NULL AND "scoreHome" > 0 LIMIT 5').all()
  console.log(JSON.stringify(sample, null, 2))
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
