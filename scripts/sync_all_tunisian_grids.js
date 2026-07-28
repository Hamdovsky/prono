const fs = require('fs')
const path = require('path')
const { scrapeBatch } = require('../core/promosport_tunisie_scraper')
const { rebuildCrowdProfile } = require('./crowd_collector')

const VOTE_HISTORY_PATH = path.join(__dirname, '..', 'data', 'tunisian_vote_history.json')

async function main() {
  console.log('Scraping all historical Tunisian grids (870-875)...\n')

  const grids = await scrapeBatch(870, 875)
  if (grids.length === 0) {
    console.log('No grids found')
    return
  }

  const allMatches = []
  for (const grid of grids) {
    for (const m of grid.matches) {
      if (!m.result || !m.publicVote || m.result === 'N') continue
      allMatches.push({
        grid: grid.no,
        idx: m.idx,
        home: m.home,
        away: m.away,
        scoreHome: m.scoreHome,
        scoreAway: m.scoreAway,
        result: m.result,
        vote1: m.publicVote.p1,
        voteX: m.publicVote.px,
        vote2: m.publicVote.p2,
        collectedAt: new Date().toISOString(),
      })
    }
  }

  fs.writeFileSync(VOTE_HISTORY_PATH, JSON.stringify(allMatches, null, 2))

  // Rebuild profile from all data
  await rebuildCrowdProfile(allMatches)

  const right = allMatches.filter((m) => {
    const picks = [
      { label: '1', pct: m.vote1 },
      { label: 'X', pct: m.voteX },
      { label: '2', pct: m.vote2 },
    ]
    picks.sort((a, b) => b.pct - a.pct)
    return picks[0].label === m.result
  }).length

  console.log(`\n========================================`)
  console.log(`Résultat final`)
  console.log(`========================================`)
  console.log(`Grilles: ${grids.length} (${grids.map((g) => g.no).join(', ')})`)
  console.log(`Matchs avec votes: ${allMatches.length}`)
  console.log(
    `Foule correcte: ${right}/${allMatches.length} (${((right / allMatches.length) * 100).toFixed(1)}%)`
  )
  console.log(`Sauvegardé dans: tunisian_vote_history.json + crowd_profile.json`)
}

main().catch(console.error)
