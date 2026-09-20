/**
 * Tests buildGroupedByTime (E65) — regroupement des matchs par tranche horaire
 * pour la grille virtualisée.
 */
const {
  buildGroupedByTime,
  computeGroupedListHeight,
  SECTION_ROW_HEIGHT,
} = require('../src/utils/dashboardFilters')

const mk = (over = {}) => ({
  id: 'm-' + Math.random().toString(36).slice(2),
  startTimestamp: 0,
  ...over,
})

// now = 2026-09-18 15:00 local (vendredi)
const NOW = new Date(2026, 8, 18, 15, 0, 0).getTime()
const ts = (d) => Math.floor(d.getTime() / 1000) // secondes (startTimestamp brut)

describe('buildGroupedByTime — sections par tranche horaire (E65)', () => {
  test('regroupe par jour + matin/après-midi/soir/nuit', () => {
    const today10 = new Date(2026, 8, 18, 10, 0)
    const today14 = new Date(2026, 8, 18, 14, 0)
    const today20 = new Date(2026, 8, 18, 20, 0)
    const today23 = new Date(2026, 8, 18, 23, 0)
    const tomorrow9 = new Date(2026, 8, 19, 9, 0)
    const list = [mk({ startTimestamp: ts(today10) }), mk({ startTimestamp: ts(today23) }), mk({ startTimestamp: ts(tomorrow9) }), mk({ startTimestamp: ts(today14) }), mk({ startTimestamp: ts(today20) })]
    const flat = buildGroupedByTime(list, NOW)
    const sections = flat.filter((i) => i.type === 'section').map((i) => i.label)
    expect(sections).toEqual([
      "Aujourd'hui · Matin",
      "Aujourd'hui · Après-midi",
      "Aujourd'hui · Soir",
      "Aujourd'hui · Nuit",
      'Demain · Matin',
    ])
  })

  test('alternance section / match dans la liste aplatie', () => {
    const d = new Date(2026, 8, 18, 10, 0)
    const list = [mk({ id: 'a', startTimestamp: ts(d) }), mk({ id: 'b', startTimestamp: ts(d) })]
    const flat = buildGroupedByTime(list, NOW)
    expect(flat.map((i) => i.type)).toEqual(['section', 'match', 'match'])
    expect(flat[0].label).toBe("Aujourd'hui · Matin")
    expect(flat[0].count).toBe(2)
    expect(flat[1].match.id).toBe('a')
    expect(flat[2].match.id).toBe('b')
  })

  test('tri des matchs par heure à l\'intérieur d\'un groupe', () => {
    const d1 = new Date(2026, 8, 18, 10, 30)
    const d2 = new Date(2026, 8, 18, 10, 0)
    const d3 = new Date(2026, 8, 18, 10, 45)
    const list = [mk({ id: 'late', startTimestamp: ts(d1) }), mk({ id: 'early', startTimestamp: ts(d2) }), mk({ id: 'last', startTimestamp: ts(d3) })]
    const flat = buildGroupedByTime(list, NOW)
    const matchItems = flat.filter((i) => i.type === 'match')
    expect(matchItems.map((i) => i.match.id)).toEqual(['early', 'late', 'last'])
  })

  test('groupes vides sont ignorés', () => {
    const list = [mk({ startTimestamp: ts(new Date(2026, 8, 18, 10, 0)) })]
    const flat = buildGroupedByTime(list, NOW)
    expect(flat.filter((i) => i.type === 'section')).toHaveLength(1)
  })

  test('matchs sans timestamp -> section "Sans heure" en fin', () => {
    const list = [mk({ id: 'a', startTimestamp: 0 }), mk({ id: 'b', startTimestamp: ts(new Date(2026, 8, 18, 10, 0)) })]
    const flat = buildGroupedByTime(list, NOW)
    const sections = flat.filter((i) => i.type === 'section').map((i) => i.label)
    expect(sections[sections.length - 1]).toBe('Sans heure')
    expect(flat[flat.length - 1].type).toBe('match')
    expect(flat[flat.length - 1].match.id).toBe('a')
  })

  test('liste vide -> liste vide', () => {
    expect(buildGroupedByTime([], NOW)).toEqual([])
    expect(buildGroupedByTime(null, NOW)).toEqual([])
  })
})

describe('computeGroupedListHeight (E65)', () => {
  test('somme des hauteurs avec cap', () => {
    const flat = [
      { type: 'section' },
      { type: 'match' },
      { type: 'match' },
      { type: 'section' },
      { type: 'match' },
    ]
    // 2 sections * 32 + 3 matches * 64 = 64 + 192 = 256
    expect(computeGroupedListHeight(flat, 64)).toBe(256)
  })
  test('cap appliqué', () => {
    const flat = Array.from({ length: 100 }, () => ({ type: 'match' }))
    expect(computeGroupedListHeight(flat, 64, 200)).toBe(200)
  })
  test('SECTION_ROW_HEIGHT exporté', () => {
    expect(SECTION_ROW_HEIGHT).toBeGreaterThan(0)
  })
})
