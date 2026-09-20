/**
 * Tests highlightText (E66) — surlignage de la recherche dans les cellules
 * (ligue, équipes) avec gestion accents/casse.
 */
const { highlightText } = require('../src/utils/matchAnalysis')

describe('highlightText — surlignage recherche (E66)', () => {
  test('pas de query -> un seul segment non-matché', () => {
    expect(highlightText('Manchester City', '')).toEqual([{ text: 'Manchester City', match: false }])
    expect(highlightText('Manchester City', null)).toEqual([{ text: 'Manchester City', match: false }])
  })

  test("match simple insensible à la casse", () => {
    expect(highlightText('Arsenal vs Chelsea', 'arsenal')).toEqual([
      { text: 'Arsenal', match: true },
      { text: ' vs Chelsea', match: false },
    ])
  })

  test('insensible aux accents', () => {
    const out = highlightText('Réal Madrid vs Séville', 'real')
    expect(out.find((s) => s.match).text).toBe('Réal')
    const out2 = highlightText('Châteauroux', 'chateauroux')
    expect(out2.find((s) => s.match).text).toBe('Châteauroux')
  })

  test('plusieurs occurrences -> plusieurs segments match', () => {
    const out = highlightText('Barca vs Barca B', 'barca')
    const matches = out.filter((s) => s.match)
    expect(matches).toHaveLength(2)
    expect(matches[0].text.toLowerCase()).toBe('barca')
  })

  test('pas de match -> un seul segment non-matché', () => {
    expect(highlightText('Liverpool', 'manchester')).toEqual([{ text: 'Liverpool', match: false }])
  })

  test('match en début', () => {
    const out = highlightText('Marseille', 'marseille')
    expect(out).toEqual([{ text: 'Marseille', match: true }])
  })

  test('match en fin', () => {
    const out = highlightText('vs Marseille', 'marseille')
    expect(out).toEqual([{ text: 'vs ', match: false }, { text: 'Marseille', match: true }])
  })

  test('texte vide / null', () => {
    expect(highlightText('', 'arsenal')).toEqual([{ text: '', match: false }])
    expect(highlightText(null, 'arsenal')).toEqual([{ text: '', match: false }])
  })
})
