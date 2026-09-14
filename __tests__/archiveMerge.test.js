/**
 * archiveMerge.mergeOddsIntoFullData (E29 Etape 1.1) — preservation des cotes a
 * l'archivage. Pur : aucune DB. Verrouille "ne jamais ecraser une cote deja en
 * fullData" et "ne jamais inventer une cote absente".
 */
const { mergeOddsIntoFullData, ODD_FIELDS } = require('../core/archiveMerge')

test('injecte les cotes de la ligne dans un fullData sans cotes', () => {
  const row = { odds_home: 1.9, odds_draw: 3.4, odds_away: 4.1, odds_source: 'betexplorer' }
  const fd = mergeOddsIntoFullData({ prediction: '1' }, row)
  expect(fd.odds_home).toBe(1.9)
  expect(fd.odds_source).toBe('betexplorer')
  expect(fd.prediction).toBe('1') // champs existants preserves
})

test('NE recouvre PAS une cote deja presente dans fullData', () => {
  const row = { odds_home: 9.9 }
  const fd = mergeOddsIntoFullData({ odds_home: 1.7 }, row)
  expect(fd.odds_home).toBe(1.7) // l'archive garde la valeur d'origine
})

test('ignore les cotes absentes/vides (ne reinvente rien)', () => {
  const row = { odds_home: null, odds_draw: '', odds_away: 2.2 }
  const fd = mergeOddsIntoFullData({}, row)
  expect('odds_home' in fd).toBe(false)
  expect('odds_draw' in fd).toBe(false)
  expect(fd.odds_away).toBe(2.2)
})

test('row null -> fd renvoye (copie), pas de crash', () => {
  expect(mergeOddsIntoFullData({ a: 1 }, null)).toEqual({ a: 1 })
  expect(mergeOddsIntoFullData(null, { odds_home: 2 })).toEqual({ odds_home: 2 })
})

test('ne mute pas l objet fd d origine', () => {
  const fd0 = { x: 1 }
  mergeOddsIntoFullData(fd0, { odds_home: 3 })
  expect(fd0).toEqual({ x: 1 })
})

test('couvre bien over/under + btts (champs HT/corner ajoutes plus tard)', () => {
  expect(ODD_FIELDS).toEqual(expect.arrayContaining(['odds_over25', 'odds_under25', 'odds_btts_yes', 'odds_btts_no']))
})
