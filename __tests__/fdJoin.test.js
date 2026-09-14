/**
 * fdJoin (E29 1.3) — jointure + garde + extraction cotes 1X2 cloture. Pur.
 */
const { normTeam, normDate, joinKey, ftCoherent, pickClosingOdds, pickClosingOU } = require('../core/fdJoin')

test('normTeam: accents, ponctuation, tokens, aliases (config/teamAliases)', () => {
  expect(normTeam('Manchester Utd')).toBe('manchester united')
  expect(normTeam('Man United')).toBe('manchester united')
  expect(normTeam('Inter Milan')).toBe(normTeam('Internazionale'))
  expect(normTeam('Atlético Madrid')).toBe('atletico madrid')
  expect(normTeam('AFC Bournemouth')).toBe('bournemouth')
  expect(normTeam('Swansea City')).toBe('swansea')
})

test('normDate: DD/MM/YY et ISO', () => {
  expect(normDate('15/08/25')).toBe('2025-08-15')
  expect(normDate('15/08/2025')).toBe('2025-08-15')
  expect(normDate('2025-08-15T00:00')).toBe('2025-08-15')
  expect(normDate('bad')).toBeNull()
})

test('joinKey symetrique et normalisee', () => {
  expect(joinKey('2025-08-15', 'Liverpool FC', 'AFC Bournemouth'))
    .toBe(joinKey('2025-08-15', 'Liverpool', 'Bournemouth'))
})

test('ftCoherent: garde anti-faux-match', () => {
  expect(ftCoherent('2', '1', 2, 1)).toBe(true)
  expect(ftCoherent('2', '1', 2, 0)).toBe(false)
  expect(ftCoherent('', '', 0, 0)).toBe(false) // non parseable
})

test('pickClosingOdds: priorite B365 -> Avg -> PS, et null si absent', () => {
  expect(pickClosingOdds({ B365H: '1.9', B365D: '3.4', B365A: '4.1', AvgH: '1.8', AvgD: '3.5', AvgA: '4.2' })).toMatchObject({ home: 1.9, source: 'footballdata_b365' })
  expect(pickClosingOdds({ AvgH: '1.8', AvgD: '3.5', AvgA: '4.2' })).toMatchObject({ home: 1.8, source: 'footballdata_avg' })
  expect(pickClosingOdds({})).toBeNull()
  expect(pickClosingOdds({ B365H: '1.9' })).toBeNull() // triplete incomplete
  expect(pickClosingOdds({ B365H: '0', B365D: '0', B365A: '0' })).toBeNull() // <=1 -> invalide
})

test('pickClosingOU : B365 -> Avg -> Pinnacle sur >2.5/<2.5', () => {
  expect(pickClosingOU({ 'B365>2.5': '1.9', 'B365<2.5': '1.9', 'Avg>2.5': '1.85', 'Avg<2.5': '1.95' })).toMatchObject({ over: 1.9, under: 1.9, source: 'footballdata_b365' })
  expect(pickClosingOU({ 'Avg>2.5': '1.85', 'Avg<2.5': '1.95' })).toMatchObject({ over: 1.85, source: 'footballdata_avg' })
  expect(pickClosingOU({ 'P>2.5': '1.9', 'P<2.5': '1.9' })).toMatchObject({ over: 1.9, source: 'footballdata_psn' })
  expect(pickClosingOU({})).toBeNull()
  expect(pickClosingOU({ 'B365>2.5': '1.9' })).toBeNull() // paire incomplete
})
