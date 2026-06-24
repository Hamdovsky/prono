const promosportIntelligence = require('../services/promosportIntelligence')

const testMatches = [
  { id: 1, homeTeam: 'Real Madrid', awayTeam: 'Barcelona', homeWinProbability: 0.70, drawProbability: 0.20, awayWinProbability: 0.10 },
  { id: 2, homeTeam: 'Man City', awayTeam: 'Liverpool', homeWinProbability: 0.60, drawProbability: 0.25, awayWinProbability: 0.15 },
  { id: 3, homeTeam: 'Burnley', awayTeam: 'Man City', homeWinProbability: 0.20, drawProbability: 0.30, awayWinProbability: 0.50 }
]

console.log('🔧 Testing Secret Weapons with calibration and crowd analysis...')
console.log('==============================================================\n')

promosportIntelligence.generateSecretWeapons(testMatches).then(result => {
  console.log('✅ Results:')
  result.forEach(w => {
    console.log(`\nMatch ${w.id}: ${w.home} vs ${w.away}`)
    console.log(`  Original probabilities: ${w.p1}%/${w.px}%/${w.p2}%`)
    console.log(`  Calibrated probabilities: ${w.p1Cal}%/${w.pxCal}%/${w.p2Cal}%`)
    console.log(`  Crowd analysis: ${w.crowdAnalysis.length > 0 ? w.crowdAnalysis.join(' | ') : 'None'}`)
    console.log(`  Competition intel: ${w.competitionIntel.trapLevel}% trap level at position ${w.competitionIntel.position}`)
    console.log(`  Secret weapon: ${w.secretWeapon}`)
    console.log(`  Boldness: ${w.boldness}`)
  })
  console.log('\n✅ Integration test completed!')
}).catch(console.error)