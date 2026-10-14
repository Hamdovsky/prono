/**
 * Tests tableColumns.js — responsive E62 :
 * filtrage par largeur (paliers), grille minmax(0, fr) et séparateurs de groupe.
 */
const {
  COLUMN_WIDTH_TIERS,
  columnsForWidth,
  mcColumnsCss,
  MC_COLS_FALLBACK,
  groupStarts,
} = require('../src/utils/tableColumns')

describe('tableColumns — responsive (E62)', () => {
  test('columnsForWidth : paliers 2 -> 4 -> 8 -> 11 colonnes', () => {
    const keys = (w) => columnsForWidth(w).map((c) => c.key)
    expect(keys(400)).toEqual(['info', 'top'])
    expect(keys(560)).toEqual(['info', 'top', 'ou', 'win'])
    expect(keys(860)).toEqual([
      'info',
      'top',
      'btts',
      'ou',
      'win',
      'ht',
      'corners',
      'combo',
    ])
    expect(keys(1040)).toEqual([
      'info',
      'top',
      'btts',
      'ou',
      'win',
      'ht',
      'corners',
      'combo',
      'htft',
      'ah',
      'tts',
    ])
  })

  test('columnsForWidth : largeur 0 ou invalide -> colonnes de base', () => {
    expect(columnsForWidth(0).map((c) => c.key)).toEqual(['info', 'top'])
    expect(columnsForWidth(undefined).map((c) => c.key)).toEqual(['info', 'top'])
    expect(columnsForWidth('abc').map((c) => c.key)).toEqual(['info', 'top'])
  })

  test('la somme des min affichés tient dans la largeur de chaque palier', () => {
    for (const w of COLUMN_WIDTH_TIERS.filter((x) => x > 0)) {
      const total = columnsForWidth(w).reduce((s, c) => s + c.min, 0)
      expect(total).toBeLessThanOrEqual(w)
    }
  })

  test('mcColumnsCss : pistes minmax(0, Xfr), jamais de fr nu qui déborde', () => {
    const css = mcColumnsCss()
    expect(css).toContain('minmax(0, 17fr)')
    expect(css).not.toMatch(/(^|\s)\d+fr(\s|$)/)
    expect(MC_COLS_FALLBACK).toBe(css)
  })

  test('mcColumnsCss : une piste par colonne visible', () => {
    const css = mcColumnsCss(columnsForWidth(560))
    expect((css.match(/minmax\(/g) || []).length).toBe(4)
  })

  test('groupStarts : séparateurs avant top, btts et htft', () => {
    expect([...groupStarts()].sort()).toEqual(['btts', 'htft', 'top'])
  })

  test('groupStarts : recalculé sur la sélection filtrée', () => {
    const cols = columnsForWidth(560) // info, top, ou, win
    expect([...groupStarts(cols)].sort()).toEqual(['ou', 'top'])
  })
})

describe('tableColumns — tri (E63)', () => {
  const {
    TABLE_COLUMNS: T,
    SORT_DEFAULT_DIRS,
    VALID_SORTS,
  } = require('../src/utils/tableColumns')
  test('sortKey présent sur les colonnes triables, null sur les autres', () => {
    const sortable = ['info', 'top', 'btts', 'ou', 'win', 'ht', 'corners', 'combo']
    const notSortable = ['htft', 'ah', 'tts']
    for (const k of sortable) {
      expect(T.find((c) => c.key === k).sortKey).toBeTruthy()
    }
    for (const k of notSortable) {
      expect(T.find((c) => c.key === k).sortKey).toBeNull()
    }
  })
  test('% triés desc par défaut, temps et ligue asc', () => {
    expect(SORT_DEFAULT_DIRS.time).toBe('asc')
    expect(SORT_DEFAULT_DIRS.league).toBe('asc')
    for (const k of ['top', 'win', 'ou', 'btts', 'ht', 'corners', 'combo']) {
      expect(SORT_DEFAULT_DIRS[k]).toBe('desc')
    }
  })
  test('VALID_SORTS cohérent avec SORT_DEFAULT_DIRS', () => {
    expect(VALID_SORTS.sort()).toEqual(Object.keys(SORT_DEFAULT_DIRS).sort())
  })
})
