/**
 * E76 — l'origine de la cote décide si une ligne compte dans un ROI.
 *
 * E75 a supprimé les cotes fabriquées (1.00 / 1.20 / 2.00) et joint désormais
 * les lignes sans prix : `odds=NULL`, `profit=NULL`, `odds_source='absente'`.
 * E76 va plus loin : la table `bets` porte désormais l'origine du prix dans
 * `odds_source`, et les statistiques s'appuient dessus au lieu de deviner.
 *
 * Mesure sur data/tactical.db après backfill (scripts/backfill_bets_odds_source.py) :
 *   repli   11 994 lignes (91,2 %)  ROI +12,53 %
 *   reelle   1 162 lignes ( 8,8 %)  ROI  -3,65 %
 *
 * Autrement dit : le ledger enrichi de cotes fabriquées est le seul rentable.
 * C'est pour ça que `odds_source` doit être une donnée, pas une convention
 * implicite.
 */

const path = require('path')

function load() {
  jest.resetModules()
  return require(path.join(__dirname, '..', 'routes', 'bets'))
}

const row = (over = {}) => ({
  stake: 1,
  result: 'won',
  odds: 2.0,
  odds_source: null,
  ...over,
})

describe('E76 — betOddsClass', () => {
  test('odds_source renseigné prime sur la valeur', () => {
    const { __test_betOddsClass: cls } = load()
    // Une cote 2.00 étiquetée 'reelle' est un vrai prix de marché : c'est le
    // champ qui fait foi, sinon on rejetterait des cotes légitimes.
    expect(cls({ odds: 2.0, odds_source: 'reelle' })).toBe('exploitable')
    // Et une cote de marché inexplicable étiquetée 'repli' reste un repli.
    expect(cls({ odds: 3.7, odds_source: 'repli' })).toBe('repli')
    expect(cls({ odds: null, odds_source: 'absente' })).toBe('absente')
    expect(cls({ odds: 1.9, odds_source: 'manuel' })).toBe('exploitable')
  })

  test('sans odds_source, on retombe sur la détection par valeur', () => {
    const { __test_betOddsClass: cls } = load()
    expect(cls({ odds: 1.0 })).toBe('repli')
    expect(cls({ odds: 1.2 })).toBe('repli')
    expect(cls({ odds: 2.0 })).toBe('repli')
    expect(cls({ odds: 1.87 })).toBe('exploitable')
    expect(cls({ odds: null })).toBe('absente')
  })
})

describe('E76 — computeStats sépare les trois origines', () => {
  test('absente n\'est pas compté comme repli', () => {
    const { __test_computeStats: stats } = load()
    const s = stats([
      row({ odds: 2.0, odds_source: 'repli', result: 'won', stake: 10 }),
      row({ odds: null, odds_source: 'absente', result: 'won', stake: 10, profit: null }),
    ])
    // Agréger « pas de prix » aux « prix inventés » ferait croire à des pertes
    // réelles sur des lignes où aucun prix n'a jamais existé.
    expect(s.syntheticOddsCount).toBe(1)
    expect(s.missingOddsCount).toBe(1)
    expect(s.realOddsCount).toBe(0)
    expect(s.realRoi).toBeNull()
  })

  test('le ROI ne porte que sur les cotes exploitables', () => {
    const { __test_computeStats: stats } = load()
    const s = stats([
      // cote de marché : 10 misés, 20 retournés
      row({ odds: 2.0, odds_source: 'reelle', result: 'won', stake: 10 }),
      // cote de marché : 10 misés, 0 retourné
      row({ odds: 2.0, odds_source: 'reelle', result: 'lost', stake: 10 }),
      // repli : ne doit pas entrer dans le ROI
      row({ odds: 2.0, odds_source: 'repli', result: 'won', stake: 1000 }),
    ])
    expect(s.realOddsCount).toBe(2)
    expect(s.realTotalStaked).toBe(20)
    expect(s.realNetProfit).toBe(0)
    expect(s.realRoi).toBe(0)
    expect(s.oddsPartlySynthetic).toBe(true)
  })

  test('les cotes saisies à la main comptent mais sont tracées', () => {
    const { __test_computeStats: stats } = load()
    const s = stats([row({ odds: 1.9, odds_source: 'manuel', result: 'won', stake: 10 })])
    expect(s.realOddsCount).toBe(1)
    expect(s.manualOddsCount).toBe(1)
  })
})
