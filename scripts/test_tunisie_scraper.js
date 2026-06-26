const { scrapeTunisieGrid, scrapeTunisieGrids } = require('../core/promosport_tunisie_scraper')
const fs = require('fs')
const path = require('path')

async function main() {
  console.log('🔧 Test scraper Promosport Tunisie')
  console.log('==================================\n')

  // Test single grid
  console.log('1. Testing single grid (876)...')
  const grid876 = await scrapeTunisieGrid(876)
  if (grid876) {
    console.log(`   Grid: ${grid876.no}`)
    console.log(`   Cagnotte: ${grid876.cagnotte} TND`)
    grid876.matches.forEach(m => {
      const vote = m.publicVote
        ? `${(m.publicVote.p1*100).toFixed(0)}% / ${(m.publicVote.px*100).toFixed(0)}% / ${(m.publicVote.p2*100).toFixed(0)}%`
        : 'N/A'
      const score = m.scoreHome != null ? `${m.scoreHome}-${m.scoreAway}` : '?'
      console.log(`   #${m.idx} ${m.home} vs ${m.away} [${score}] → ${m.result || '?'}`)
      console.log(`        Public: ${vote}`)
    })
  } else {
    console.log('   ❌ Failed grid 876')
  }

  console.log('\n2. Testing grid 875 with Ecuador match...')
  const grid875 = await scrapeTunisieGrid(875)
  if (grid875) {
    const ecuMatch = grid875.matches.find(m => m.home.includes('Ecuad') || m.away.includes('Ecuad'))
    if (ecuMatch) {
      console.log(`   Found Ecuador! Match #${ecuMatch.idx}: ${ecuMatch.home} vs ${ecuMatch.away}`)
      console.log(`   Result: ${ecuMatch.result} (${ecuMatch.scoreHome}-${ecuMatch.scoreAway})`)
      if (ecuMatch.publicVote) {
        console.log(`   Public vote: ${(ecuMatch.publicVote.p1*100).toFixed(0)}% / ${(ecuMatch.publicVote.px*100).toFixed(0)}% / ${(ecuMatch.publicVote.p2*100).toFixed(0)}%`)
        const voted = Object.entries(ecuMatch.publicVote).sort((a,b) => b[1]-a[1])[0]
        const publicPick = voted[0] === 'p1' ? '1' : (voted[0] === 'px' ? 'X' : '2')
        console.log(`   Crowd picked: ${publicPick} at ${(voted[1]*100).toFixed(0)}%`)
        console.log(`   Actual result: ${ecuMatch.result}`)
        console.log(`   Crowd was WRONG: ${publicPick !== ecuMatch.result ? '✅' : '❌'}`)
      }
    } else {
      console.log('   Ecuador not in grid 875')
    }
  }

  console.log('\n✅ Test completed')
}

main().catch(console.error)
