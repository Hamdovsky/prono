/**
 * archiveMerge.mergeOddsIntoFullData (E29 Etape 1.1) — preservation des cotes a
 * l'archivage. Pur : aucune DB. Verrouille "ne jamais ecraser une cote deja en
 * fullData" et "ne jamais inventer une cote absente".
 */
const { mergeOddsIntoFullData, mergeIncidentsIntoFullData, ODD_FIELDS, STATS_FIELDS } = require('../core/archiveMerge')

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

test("E37 - preserve aussi les STATS FotMob (fotmob_id/xg/corners/ht/shots/poss)", () => {
  expect(STATS_FIELDS).toEqual(expect.arrayContaining(['fotmob_id','home_xg','away_xg','corners_home','ht_score_home','possession_home','corners_ht_home']))
  const row = { fotmob_id: '5795448', home_xg: 1.33, corners_home: 5, ht_score_home: 1, possession_home: 30 }
  const fd = mergeOddsIntoFullData({ prediction: '1' }, row)
  expect(fd.fotmob_id).toBe('5795448')
  expect(fd.home_xg).toBe(1.33)
  expect(fd.ht_score_home).toBe(1)
  expect(fd.prediction).toBe('1')
  // ne pas ecraser une valeur deja presente (fd)
  const fd2 = mergeOddsIntoFullData({ fotmob_id: 'AAA', corners_home: 99 }, { fotmob_id: '5795448', corners_home: 5 })
  expect(fd2.fotmob_id).toBe('AAA')
  expect(fd2.corners_home).toBe(99)
})

// ---------------------------------------------------------------------------
// E71-ter : mergeIncidentsIntoFullData renvoie le fullData ENTIER, pas la liste.
// Le backfill faisait `merged.incidents = mergeIncidentsIntoFullData(...)`, ce
// qui stockait un OBJET sous la cle `incidents` -> json_array_length() = 0 sur
// toutes les lignes alors que la cle etait presente (symptome trompeur). Ces
// tests verrouillent les DEUX moities du contrat : ce que la fonction renvoie,
// et la facon de l'appliquer sans ecraser `incidents`.
// ---------------------------------------------------------------------------
test('E71-ter - mergeIncidents renvoie le fullData complet, incidents inclus', () => {
  const inc = [
    { time: 8, type: 'goal', incidentClass: 'regular', isHome: true, text: 'Goal' },
    { time: 23, type: 'card', incidentClass: 'yellow', isHome: false, text: 'Yellow' },
  ]
  const out = mergeIncidentsIntoFullData({ prediction: '1', home_xg: 1.4 }, inc)
  expect(out).toEqual({ prediction: '1', home_xg: 1.4, incidents: inc })
  // le contrat central : le champ est bien un TABLEAU, pas un objet imbrique
  expect(Array.isArray(out.incidents)).toBe(true)
  expect(out.incidents).toHaveLength(2)
})

test('E71-ter - application par Object.assign (le pattern du backfill)', () => {
  const inc = [{ time: 50, type: 'card', incidentClass: 'yellow', isHome: false }]
  const merged = { prediction: '1' }
  Object.assign(merged, mergeIncidentsIntoFullData(merged, inc))
  expect(Array.isArray(merged.incidents)).toBe(true)
  expect(merged.incidents).toHaveLength(1)
  // ce que JSON.stringify -> json_array_length() doit lire en base
  expect(JSON.parse(JSON.stringify(merged)).incidents).toHaveLength(1)
})

test('E71-ter - incidents vides / invalides : la copie est inchangee', () => {
  expect(mergeIncidentsIntoFullData({ a: 1 }, [])).toEqual({ a: 1 })
  expect(mergeIncidentsIntoFullData({ a: 1 }, null)).toEqual({ a: 1 })
  expect('incidents' in mergeIncidentsIntoFullData({ a: 1 }, [])).toBe(false)
})

test('E71-ter - NE recouvre PAS une timeline deja presente', () => {
  const dejaLa = [{ time: 8, type: 'goal', incidentClass: 'regular', isHome: true }]
  const out = mergeIncidentsIntoFullData({ incidents: dejaLa }, [{ time: 99, type: 'card' }])
  expect(out.incidents).toBe(dejaLa)
  expect(out.incidents).toHaveLength(1)
})

test('E71-ter - ne mute pas l objet fd d origine', () => {
  const fd0 = { x: 1 }
  mergeIncidentsIntoFullData(fd0, [{ time: 8, type: 'goal' }])
  expect(fd0).toEqual({ x: 1 })
})
