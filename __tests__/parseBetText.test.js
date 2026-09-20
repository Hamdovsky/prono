/**
 * Tests parseBetText (E64) — décompose un libellé de pari "PICK PCT%" en
 * {pick, pct} pour permettre le rendu d'une tuile "PICK / @ODDS" par marché.
 */
const { parseBetText } = require('../src/utils/matchAnalysis')

describe('parseBetText — décomposition pick/pct (E64)', () => {
  test('cas OUI/NON avec pourcentage', () => {
    expect(parseBetText('OUI 60%')).toEqual({ pick: 'OUI', pct: 60 })
    expect(parseBetText('NON 55%')).toEqual({ pick: 'NON', pct: 55 })
  })
  test("nom d'équipe + pourcentage (1X2)", () => {
    expect(parseBetText('Milan 55%')).toEqual({ pick: 'Milan', pct: 55 })
    expect(parseBetText('Match nul 30%')).toEqual({ pick: 'Match nul', pct: 30 })
  })
  test('pari double chance', () => {
    expect(parseBetText('1X 60%')).toEqual({ pick: '1X', pct: 60 })
    expect(parseBetText('X2 45%')).toEqual({ pick: 'X2', pct: 45 })
  })
  test('O/U avec ligne', () => {
    expect(parseBetText('OVER 2.5 65%')).toEqual({ pick: 'OVER 2.5', pct: 65 })
  })
  test('libellé sans pourcentage (corners exact)', () => {
    expect(parseBetText('✚ 4')).toEqual({ pick: '✚ 4', pct: null })
  })
  test('pourcentage décimal', () => {
    expect(parseBetText('OUI 60.5%')).toEqual({ pick: 'OUI', pct: 60.5 })
  })
  test('valeurs vides / sentinelles -> null', () => {
    expect(parseBetText(null)).toBeNull()
    expect(parseBetText(undefined)).toBeNull()
    expect(parseBetText('')).toBeNull()
    expect(parseBetText('--')).toBeNull()
    expect(parseBetText('—')).toBeNull()
    expect(parseBetText('-')).toBeNull()
  })
  test("espaces superflus tolérés", () => {
    expect(parseBetText('  OUI  60%  ')).toEqual({ pick: 'OUI', pct: 60 })
  })
})
