const path = require('path')
const db = require(path.join(__dirname, '..', 'core', 'database'))

async function main() {
  const all = await db.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS', 'upcoming'])

  const matches = all
    .filter(m => m.prediction && m.confidence >= 55 && m.home_win_probability > 0)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 25)

  if (matches.length === 0) {
    console.log('Aucun match trouvé avec ces critères.')
    return
  }

  console.log(`\n🏆  PRONOSTICS TITANIUM AI  (confiance ≥ 55%)\n`)
  console.log('═'.repeat(85))

  for (const m of matches) {
    const start = new Date(m.startTimestamp).toLocaleString('fr-FR', {
      weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit'
    })
    const proba = `${m.home_win_probability.toFixed(0)}% / ${m.draw_probability.toFixed(0)}% / ${m.away_win_probability.toFixed(0)}%`
    const market = m.market_scope || m.market_type || '1X2'
    const stars = m.confidence >= 80 ? '⭐⭐⭐' : m.confidence >= 70 ? '⭐⭐' : '⭐'

    console.log(`${stars} [${m.confidence}%]  ${m.homeTeam} vs ${m.awayTeam}`)
    console.log(`   📅 ${start}  |  ${m.league}`)
    console.log(`   🎯 ${m.prediction}  |  1X2: ${proba}`)
    console.log(`   🔎 Marché: ${market}`)
    console.log('')
  }

  console.log('═'.repeat(85))
  console.log(`\n💡 25 meilleurs matchs triés par confiance décroissante\n`)
}

main().catch(console.error)
