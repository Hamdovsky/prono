/**
 * Test du helper pur d'extraction HT livescore (E27). Sans dependance DB/reseau.
 */
const { deriveHtFromLivescore } = require('../core/livescoreHt')

test('Trh presents et <= FT -> HT retourne', () => {
  expect(deriveHtFromLivescore({ Tr1: '4', Tr2: '2', Trh1: '1', Trh2: '0' })).toEqual({ home: 1, away: 0 })
})

test('Trh absents -> nulls', () => {
  expect(deriveHtFromLivescore({ Tr1: '1', Tr2: '0' })).toEqual({ home: null, away: null })
  expect(deriveHtFromLivescore({ Tr1: '1', Tr2: '0', Trh1: '', Trh2: '' })).toEqual({ home: null, away: null })
})

test('HT > FT (incoherent) -> nulls (jamais de faux HT ecrit)', () => {
  expect(deriveHtFromLivescore({ Tr1: '1', Tr2: '0', Trh1: '2', Trh2: '0' })).toEqual({ home: null, away: null })
  expect(deriveHtFromLivescore({ Tr1: '1', Tr2: '0', Trh1: '1', Trh2: '3' })).toEqual({ home: null, away: null })
})

test('match nul 0-0 aux deux mi-temps -> HT 0-0 valide', () => {
  expect(deriveHtFromLivescore({ Tr1: '0', Tr2: '0', Trh1: '0', Trh2: '0' })).toEqual({ home: 0, away: 0 })
})

test('entree invalide -> nulls', () => {
  expect(deriveHtFromLivescore(null)).toEqual({ home: null, away: null })
  expect(deriveHtFromLivescore({})).toEqual({ home: null, away: null })
})
