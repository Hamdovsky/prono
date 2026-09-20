/**
 * Tests applySort + relativeTime (E63).
 */
const {
  applySort,
  relativeTime,
  parseFilterSearch,
  buildFilterSearch,
} = require('../src/utils/dashboardFilters')

const mk = (over = {}) => ({
  startTimestamp: 0,
  league: 'Ligue',
  homeTeam: 'Home',
  awayTeam: 'Away',
  ...over,
})

describe('applySort — tri cliquable (E63)', () => {
  test('sortBy null => liste inchangée (mêmes références)', () => {
    const list = [mk({ startTimestamp: 3 }), mk({ startTimestamp: 1 })]
    expect(applySort(list, null)).toBe(list)
  })

  test('tri par heure asc/desc', () => {
    const a = mk({ startTimestamp: 1700000000 })
    const b = mk({ startTimestamp: 1700001000 })
    const c = mk({ startTimestamp: 1700002000 })
    const list = [c, a, b]
    expect(applySort(list, { key: 'time', dir: 'asc' }).map((m) => m.startTimestamp))
      .toEqual([1700000000, 1700001000, 1700002000])
    expect(applySort(list, { key: 'time', dir: 'desc' }).map((m) => m.startTimestamp))
      .toEqual([1700002000, 1700001000, 1700000000])
  })

  test('tri par heure : timestamp en secondes (<1e11) normalisé en ms', () => {
    const a = mk({ startTimestamp: 100 }) // 100 s
    const b = mk({ startTimestamp: 200 }) // 200 s
    expect(applySort([b, a], { key: 'time', dir: 'asc' })[0]).toBe(a)
  })

  test('tri par ligue alphabétique (insensible aux accents)', () => {
    const list = [mk({ league: 'Ligue B' }), mk({ league: 'équipe' }), mk({ league: 'Alpha' })]
    const asc = applySort(list, { key: 'league', dir: 'asc' }).map((m) => m.league)
    expect(asc).toEqual(['Alpha', 'équipe', 'Ligue B'])
  })

  test('données manquantes envoyées en fin (NaN-safe)', () => {
    const a = mk({ startTimestamp: 500 })
    const b = mk({ startTimestamp: 0 }) // manquant
    const c = mk({ startTimestamp: 200 })
    expect(applySort([b, c, a], { key: 'time', dir: 'asc' }).map((m) => m.startTimestamp))
      .toEqual([200, 500, 0])
  })

  test("n'altère pas la liste d'origine", () => {
    const list = [mk({ startTimestamp: 3 }), mk({ startTimestamp: 1 })]
    const before = list.map((m) => m.startTimestamp)
    applySort(list, { key: 'time', dir: 'asc' })
    expect(list.map((m) => m.startTimestamp)).toEqual(before)
  })
})

describe('relativeTime — sync indicator (E63)', () => {
  const now = 1_700_000_000_000
  test('<5s => "à l\'instant"', () => expect(relativeTime(now - 2_000, now)).toBe("à l'instant"))
  test('<60s => secondes', () => expect(relativeTime(now - 12_000, now)).toBe('il y a 12s'))
  test('<60min => minutes', () => expect(relativeTime(now - 5 * 60_000, now)).toBe('il y a 5 min'))
  test('>=60min => heures', () => expect(relativeTime(now - 2 * 3600_000, now)).toBe('il y a 2 h'))
  test('null => "jamais"', () => expect(relativeTime(null, now)).toBe('jamais'))
})

describe('URL — sortBy round-trip (E63)', () => {
  test('parseFilterSearch lit sort+dir valides', () => {
    expect(parseFilterSearch('?sort=time&dir=asc').sortBy).toEqual({ key: 'time', dir: 'asc' })
    expect(parseFilterSearch('?sort=top&dir=desc').sortBy).toEqual({ key: 'top', dir: 'desc' })
  })
  test('parseFilterSearch ignore sort/dir invalides', () => {
    expect(parseFilterSearch('?sort=bogus&dir=asc').sortBy).toBeNull()
    expect(parseFilterSearch('?sort=time&dir=sideways').sortBy).toBeNull()
    expect(parseFilterSearch('').sortBy).toBeNull()
  })
  test('buildFilterSearch écrit sort+dir quand non-défaut', () => {
    expect(buildFilterSearch({ sortBy: { key: 'time', dir: 'asc' } })).toBe('?sort=time&dir=asc')
    expect(buildFilterSearch({ sortBy: { key: 'top', dir: 'desc' } })).toBe('?sort=top&dir=desc')
    expect(buildFilterSearch({ sortBy: null })).toBe('')
  })
})
