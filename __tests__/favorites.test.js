/**
 * Tests favorites.js (E21-B) — store localStorage simulé, zéro DOM.
 */
const {
  FAVORITES_KEY,
  loadFavorites,
  saveFavorites,
  toggleFavorite,
  matchHasFavorite,
} = require('../src/utils/favorites')

const fakeStore = (initial = {}) => {
  const data = { ...initial }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    },
    removeItem: (k) => delete data[k],
    dump: () => data,
  }
}

describe('loadFavorites', () => {
  it('[] si absent / corrompu / non-array', () => {
    expect(loadFavorites(fakeStore())).toEqual([])
    expect(loadFavorites(fakeStore({ [FAVORITES_KEY]: 'pas du json{{' }))).toEqual([])
    expect(loadFavorites(fakeStore({ [FAVORITES_KEY]: '{"a":1}' }))).toEqual([])
  })

  it('nettoie vides/non-strings et deduplique apres trim', () => {
    const store = fakeStore({ [FAVORITES_KEY]: JSON.stringify([' Arsenal ', '', 5, null, 'Real Madrid', 'Arsenal']) })
    expect(loadFavorites(store)).toEqual(['Arsenal', 'Real Madrid'])
  })
})

describe('saveFavorites / roundtrip', () => {
  it('persiste en JSON dans la clé dédiée', () => {
    const store = fakeStore()
    saveFavorites(['Paris', 'Lyon'], store)
    expect(JSON.parse(store.dump()[FAVORITES_KEY])).toEqual(['Paris', 'Lyon'])
    expect(loadFavorites(store)).toEqual(['Paris', 'Lyon'])
  })

  it('store absent (node / mode privé) = no-op silencieux', () => {
    expect(() => saveFavorites(['x'], null)).not.toThrow()
    expect(loadFavorites(undefined)).toEqual([])
  })
})

describe('toggleFavorite', () => {
  it('ajoute puis retire (insensible casse/accents)', () => {
    let favs = []
    favs = toggleFavorite('Atlético Madrid', favs)
    expect(favs).toEqual(['Atlético Madrid'])
    favs = toggleFavorite('atletico madrid', favs)
    expect(favs).toEqual([])
  })

  it('team vide = liste inchangée', () => {
    expect(toggleFavorite('', ['A'])).toEqual(['A'])
  })
})

describe('matchHasFavorite', () => {
  const m = { homeTeam: 'Arsenal', awayTeam: 'Chelsea' }
  it('un seul des deux camps suffit', () => {
    expect(matchHasFavorite(m, ['CHELSEA'])).toBe(true)
    expect(matchHasFavorite(m, ['arsenal'])).toBe(true)
    expect(matchHasFavorite(m, ['Everton'])).toBe(false)
    expect(matchHasFavorite(m, [])).toBe(false)
    expect(matchHasFavorite(null, ['x'])).toBe(false)
  })
})
