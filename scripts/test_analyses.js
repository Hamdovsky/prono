const competitionAnalyzer = require('../services/competitionAnalyzer')
const crowdHackerService = require('../services/crowdHackerService')
const probabilityCalibrator = require('../services/probabilityCalibrator')

console.log('🔧 Testing Calibration + Competition + Crowd Analysis')
console.log('====================================================\n')

console.log('1. Testing Probability Calibration...')
const testProbs = [0.55, 0.65, 0.75, 0.85, 0.95]
testProbs.forEach(p => {
  const calibrated = probabilityCalibrator.calibrate(p, 0.2, 0.25)
  console.log(`  Input: ${p} → Output: ${calibrated.p1.toFixed(3)} (calibrated)`)
})

console.log('\n2. Testing Competition Analysis...')
const compProfile = competitionAnalyzer.getProfile()
console.log(`  Total matches analyzed: ${compProfile.totalMatches}`)
console.log(`  Home win rate: ${compProfile.resultPct['1']}%`)
console.log(`  Draw rate: ${compProfile.resultPct['X']}%`)
console.log(`  Away win rate: ${compProfile.resultPct['2']}%`)
console.log(`  Surprise rate: ${compProfile.surpriseRate}%`)
console.log(`  Hardest concours: N°${compProfile.hardestConcours[0]?.no || 'N/A'} (${compProfile.hardestConcours[0]?.total || 0} corrects)`)

console.log('\n3. Testing Crowd Hacker...')
const crowdProfile = crowdHackerService.promosportBiasProfile
if (crowdProfile && crowdProfile.totalMatches > 0) {
  console.log(`  Promosport overall accuracy: ${crowdProfile.promosportOverallAccuracy}%`)
  console.log(`  Model vs Promosport agree: ${crowdProfile.modelVersusPromosport.agree.pct}%`)
  console.log(`  Model vs Promosport disagree: ${crowdProfile.modelVersusPromosport.disagree.pct}%`)
  console.log(`  Contrarian opportunities: ${crowdProfile.contrarianOpportunities.length}`)
  console.log(`  Contrarian hit rate: ${crowdProfile.contrarianHitRate}%`)
} else {
  console.log('  No crowd profile available (historical data missing Promosport probabilities)')
}

console.log('\n4. Testing Match Intel...')
const matchIntel = competitionAnalyzer.getMatchIntel('Real Madrid', 'Barcelona', 7)
console.log(`  Index #7 trap level: ${matchIntel.indexIntel.trapLevel}%`)
console.log(`  Analysis: ${matchIntel.analysis.join(', ') || 'None'}`)

console.log('\n5. Testing Crowd Signal...')
const testMatch = {
  homeWinProbability: 0.70,
  drawProbability: 0.20,
  awayWinProbability: 0.10
}
const crowdSignal = crowdHackerService.getContrarianSignal(testMatch)
if (crowdSignal) {
  console.log(`  Promosport pick: ${crowdSignal.promosportPick}`)
  console.log(`  Model advantage: ${crowdSignal.modelAdvantage > 0 ? '+' : ''}${crowdSignal.modelAdvantage}pts`)
  console.log(`  Historical edge: ${crowdSignal.historicalEdge ? 'Yes' : 'No'}`)
} else {
  console.log('  No crowd signal available')
}

console.log('\n✅ All tests completed successfully!')
console.log('📁 Generated files:')
console.log('   - data/competition_profile.json')
console.log('   - data/crowd_profile.json')