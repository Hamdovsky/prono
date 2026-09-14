/**
 * oddsSource (E33) — predicat pur de source de cote. Verrouille l'exclusion des
 * cotes synthetiques (fair_odds_model/...) qui corrompent EV/calibration/CLV.
 */
const { isRealBookmakerSource, oddsSourceOf, SYNTHETIC_SOURCES } = require('../core/oddsSource')

test('synthetiques rejetees', () => {
  for (const s of ['fair_odds_model', 'default', 'synthetic', 'model_league', 'historical', 'historical+elo', 'non_bookmaker:default', 'NON_BOOKMAKER'])
    expect(isRealBookmakerSource(s)).toBe(false)
  expect(isRealBookmakerSource('')).toBe(false)
  expect(isRealBookmakerSource(null)).toBe(false)
  expect(isRealBookmakerSource(undefined)).toBe(false)
})

test('vraies sources acceptees', () => {
  for (const s of ['betexplorer', 'sofascore', 'footballdata', 'football_data', 'ultimate:2-sources', 'oddsapiio', 'sportmonks', 'flashscore', '  BetExplorer  '])
    expect(isRealBookmakerSource(s)).toBe(true)
})

test('oddsSourceOf : colonne d\'abord, puis fullData(string ou obj)', () => {
  expect(oddsSourceOf({ odds_source: 'betexplorer', fullData: '{}' })).toBe('betexplorer')
  expect(oddsSourceOf({ odds_source: null, fullData: '{"odds_source":"sofascore"}' })).toBe('sofascore')
  expect(oddsSourceOf({ fullData: { odds: { source: 'footballdata' } } })).toBe('footballdata')
  expect(oddsSourceOf({ fullData: 'bad{' })).toBe(null)
})

test('SYNTHETIC_SOURCES contient bien fair_odds_model', () => {
  expect(SYNTHETIC_SOURCES.has('fair_odds_model')).toBe(true)
})
