/**
 * E76 — une courbe de calibration PLATE ne doit pas être appliquée.
 *
 * Constat mesuré sur data/tactical.db : pour le marché 1X2, les 7 bandes de la
 * courbe ont n = 22, 26, 25, 17, 19, 7, 4 — toutes sous MIN_CALIB_BAND_N = 50.
 * La construction de courbe fait donc retomber chaque bande sur le taux global
 * (48,3 %), ce qui rend la courbe PLATE.
 *
 * Appliquée à un triplet, une courbe plate rend les trois jambes IDENTIQUES ;
 * après renormalisation, 33,3 / 33,3 / 33,3. Or topPicksEngine filtre les
 * candidats sur PROB_MIN = 55 (services/topPicksEngine.js:509) : aucun pick 1X2
 * ne peut plus passer. Le calibrateur ne calibrait pas ce marché, il le
 * supprimait.
 *
 * La garde existante MIN_MARKET_SAMPLES ne le détectait pas : elle compare
 * l'effectif GLOBAL du marché (n = 120 ≥ 40), alors que la décision doit porter
 * sur la qualité des BANDES.
 *
 * Ces tests passent par la vraie base mockée (et non un spy sur getCurve) :
 * calibrate1x2 appelle getCurve en interne, donc un spy sur l'export ne
 * changerait rien et les tests passeraient pour la mauvaise raison.
 */

const mockDb = { bets: [] }

jest.mock('../core/database', () => ({
  get db() {
    return {
      prepare: (sql) => {
        const q = sql.replace(/\s+/g, ' ').trim()
        if (q.includes('FROM bets b JOIN historical_matches')) {
          return { all: () => mockDb.bets }
        }
        return { all: () => [], get: () => undefined, run: () => {} }
      },
    }
  },
}))

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

// Une entrée de betting. buildCurve exige que fullData.quant.markets
// .match_result contienne les trois issues 1 / X / 2, et que la proba du pick
// tombe dans (0, 100).
function bet(pick, won, p1) {
  const rest = (1 - p1) / 2
  return {
    pick,
    result: won ? 'won' : 'lost',
    fullData: JSON.stringify({
      quant: {
        markets: {
          match_result: { 1: { prob: p1 }, X: { prob: rest }, 2: { prob: rest } },
        },
      },
    }),
  }
}

// 7 bandes distinctes × 30 paris = 210 paris. Total >= REBUILD_MIN_SAMPLES
// (150), donc la porte d'identité laisse passer, MAIS chaque bande reste sous
// MIN_CALIB_BAND_N (50) → courbe plate. C'est exactement la situation réelle.
const BANDE_PLAQUE = [0.505, 0.555, 0.605, 0.655, 0.705, 0.755, 0.805]

describe('E76 — courbe de calibration dégénérée', () => {
  let calibrator

  beforeEach(() => {
    jest.resetModules()
    mockDb.bets = []
    calibrator = require('../services/calibrator')
  })

  test('MIN_CALIB_BAND_N est bien le seuil qui décide de la fiabilité', () => {
    expect(calibrator._internal.MIN_CALIB_BAND_N).toBe(50)
  })

  test('marché sans bande fiable : la courbe est plate et se signale comme telle', () => {
    for (const p1 of BANDE_PLAQUE) {
      for (let i = 0; i < 30; i++) mockDb.bets.push(bet('1', i % 2 === 0, p1))
    }
    const curve = calibrator.getCurve(true)
    const m = curve['1X2']
    expect(m).toBeDefined()
    expect(m.n).toBe(210)
    // La porte globale est franchie…
    expect(m.n).toBeGreaterThanOrEqual(150)
    // …mais aucune bande n'est exploitable.
    expect(m.hasReliableBands).toBe(false)
    const rates = new Set(m.bands.filter((b) => b.n > 0).map((b) => b.rate))
    expect(rates.size).toBe(1)
  })

  test('calibrate1x2 rend l\'identité quand la courbe est plate', () => {
    for (const p1 of BANDE_PLAQUE) {
      for (let i = 0; i < 30; i++) mockDb.bets.push(bet('1', i % 2 === 0, p1))
    }
    calibrator.getCurve(true)

    // Le modèle annonce 70/20/10. Une courbe plate donnerait 33,3/33,3/33,3.
    const out = calibrator.calibrate1x2({ p1: 70, px: 20, p2: 10 })
    expect(out.p1).toBeCloseTo(70, 2)
    expect(out.px).toBeCloseTo(20, 2)
    expect(out.p2).toBeCloseTo(10, 2)
    // Le risque concret que ce test verrouille : sous PROB_MIN = 55, aucun pick
    // 1X2 ne survit, le marché disparaît sans bruit.
    expect(out.p1).toBeGreaterThan(55)
  })

  test('calibrateProb rend l\'identité sur une courbe plate', () => {
    // Pick « 1 » : la proba du pick EST p1, donc les 7 valeurs de BANDE_PLAQUE
    // tombent dans 7 bandes distinctes de 30 paris chacune — toutes sous 50.
    // (Avec un pick « X » la proba vaut (1-p1)/2 et trois bandes atteignaient 60
    // observations : la courbe n'était alors plus plate, et le test ne testait
    // plus ce qu'il croyait tester.)
    for (const p1 of BANDE_PLAQUE) {
      for (let i = 0; i < 30; i++) mockDb.bets.push(bet('1', i % 2 === 0, p1))
    }
    const m = calibrator.getCurve(true)['1X2']
    expect(m.hasReliableBands).toBe(false)
    expect(calibrator.calibrateProb(45, '1X2')).toBeCloseTo(45, 5)
  })

  test('un marché avec des bandes fiables reste calibré', () => {
    // Bande 80-85 : 300 paris gagnants + 300 perdants → réel 50 % pour une
    // proba annoncée de 82 %. La correction de surconfiance doit rester visible :
    // c'est le comportement utile du calibrateur, à ne pas casser.
    for (let i = 0; i < 300; i++) mockDb.bets.push(bet('1', true, 0.82))
    for (let i = 0; i < 300; i++) mockDb.bets.push(bet('1', false, 0.82))
    calibrator.getCurve(true)

    const m = calibrator.getCurve()['1X2']
    expect(m.hasReliableBands).toBe(true)
    expect(calibrator.calibrateProb(82, '1X2')).toBeLessThan(70)
    // La surconfiance est corrigée vers le bas, pas écrasée.
    expect(calibrator.calibrateProb(82, '1X2')).toBeGreaterThan(40)
  })
})
