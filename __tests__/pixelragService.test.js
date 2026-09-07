/**
 * pixelragService — hygiène de requête wiki (fonctions pures, sans réseau).
 */
const pixelrag = require('../services/pixelragService')

describe('wikiQueriesForMatch', () => {
  test('deux requêtes saison + une requête H2H', () => {
    const season = pixelrag.currentSeasonLabel()
    expect(season).toMatch(/^\d{4}-\d{2}$/)
    const qs = pixelrag.wikiQueriesForMatch('Al-Hilal', 'Neom SC')
    expect(qs).toHaveLength(3)
    expect(qs[0]).toBe(`Al-Hilal ${season} season football`)
    expect(qs[1]).toBe(`Neom SC ${season} season football`)
    expect(qs[2]).toBe('Al-Hilal vs Neom SC football head-to-head history')
  })

  test('ignore les équipes vides (pas de H2H sans les deux)', () => {
    expect(pixelrag.wikiQueriesForMatch('', 'Neom SC')).toHaveLength(1)
    expect(pixelrag.wikiQueriesForMatch('', '')).toHaveLength(0)
  })
})

describe('filterTilesByTeams', () => {
  const tiles = [
    { url: '2026–27 Al-Hilal SFC season', source: 'wikipedia' },
    { url: 'Fahad Al-Rashidi', source: 'wikipedia' },
    { url: '2026–27 Neom SC season', source: 'wikipedia' },
    { url: 'Cruz Azul', source: 'wikipedia' },
  ]

  test('garde uniquement les tuiles dont le titre mentionne une équipe', () => {
    const kept = pixelrag.filterTilesByTeams(tiles, ['Al-Hilal', 'Neom SC'])
    expect(kept.map((t) => t.url)).toEqual([
      '2026–27 Al-Hilal SFC season',
      '2026–27 Neom SC season',
    ])
  })

  test('insensible aux accents/tirets (normalisation)', () => {
    const t = [{ url: '2026–27 Al Hilal football club season' }]
    expect(pixelrag.filterTilesByTeams(t, ['Al-Hilal'])).toHaveLength(1)
  })

  test('retombe sur la liste complète si rien ne matche (le lecteur signalera)', () => {
    const kept = pixelrag.filterTilesByTeams(tiles, ['Real Madrid'])
    expect(kept).toHaveLength(tiles.length)
  })

  test('aucune équipe fournie -> liste inchangée', () => {
    expect(pixelrag.filterTilesByTeams(tiles, ['', null])).toHaveLength(tiles.length)
  })

  test('ignore les noms trop courts (risque de faux positifs)', () => {
    const kept = pixelrag.filterTilesByTeams(tiles, ['SC'])
    expect(kept).toHaveLength(tiles.length)
  })
})
