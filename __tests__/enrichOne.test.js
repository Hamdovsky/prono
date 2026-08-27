/**
 * enrichOne — tests unitaires (audit Prio 2, 2026-08-26)
 *
 * Vérifie :
 *  - le contrat de sortie enrichOne (champs dérivés complets, jamais partiel)
 *  - Audit Prio 1/2 : engine_exit snapshot présent et fidèle aux colonnes
 *    home/draw/away_win_probability (preuve que fullData.probs == engine_exit)
 */

// Mock QuantumQuantEngine injectable AVANT le require d'enrichOne
const mockAnalyze = jest.fn()
jest.mock('../core/QuantumQuantEngine', () => ({
  analyze: (...args) => mockAnalyze(...args),
}))

const { enrichOne, engineExitDiff } = require('../core/enrichOne')

function setMock(probs = { p1: 0.5, px: 0.25, p2: 0.25 }) {
  mockAnalyze.mockImplementation(() => ({
    markets: {
      match_result: {
        '1': { prob: probs.p1 },
        X: { prob: probs.px },
        '2': { prob: probs.p2 },
      },
    },
    probs: { btts: 0.55, over25: 0.6 },
    main_pick: '1',
    risk_label: 'BALANCED',
    confidence: 60,
    expected_score: [1.5, 1.2],
    ev_score: '0.50',
  }))
}

test('enrichOne émet tous les champs dérivés (jamais un retour partiel)', async () => {
  setMock()
  const out = await enrichOne({ homeTeam: 'A', awayTeam: 'B', league: 'E0' })
  expect(out.prediction).toBe('1')
  expect(out.home_win_probability).toBe(50)
  expect(out.draw_probability).toBe(25)
  expect(out.away_win_probability).toBe(25)
  expect(out.enriched.prediction).toBe(out.prediction)
  expect(out.enriched.quant.main_pick).toBe(out.prediction)
})

test('Prio2 : engine_exit snapshot = probabilities finales du moteur', async () => {
  setMock({ p1: 0.6, px: 0.2, p2: 0.2 })
  const out = await enrichOne({ homeTeam: 'A', awayTeam: 'B', league: 'E0' })
  expect(out.engine_exit).toEqual({ p1: 60, px: 20, p2: 20, btts: 0.55, over25: 0.6 })
  // engine_exit doit être cohérent avec les colonnes persistées
  expect(out.engine_exit.p1).toBe(out.home_win_probability)
  expect(out.engine_exit.px).toBe(out.draw_probability)
  expect(out.engine_exit.p2).toBe(out.away_win_probability)
  // et répliqué dans enriched pour consultation fullData
  expect(out.enriched.engine_exit).toEqual(out.engine_exit)
})

test('Prio2 : engineExitDiff = 0 quand fullData.probs == engine_exit (chaîne fidèle)', () => {
  const engineExit = { p1: 50, px: 25, p2: 25 }
  const fullDataProbs = {
    home_win_probability: 50,
    draw_probability: 25,
    away_win_probability: 25,
  }
  expect(engineExitDiff(engineExit, fullDataProbs)).toBe(0)
})

test('Prio2 : engineExitDiff capture un écart éventuel', () => {
  const engineExit = { p1: 50, px: 25, p2: 25 }
  const drifted = {
    home_win_probability: 45,
    draw_probability: 30,
    away_win_probability: 25,
  }
  expect(engineExitDiff(engineExit, drifted)).toBe(5)
})

test('Prio2 : engineExitDiff renvoie NaN si entrée manquante', () => {
  expect(Number.isNaN(engineExitDiff(null, {}))).toBe(true)
})

test('Prio3 : marquage low-data correct (bug 0||1 fixe) — sufficient -> 0/false', async () => {
  setMock()
  const out = await enrichOne({ homeTeam: 'A', awayTeam: 'B', league: 'E0', insufficient_data: 0 })
  // Ancien code : `m.insufficient_data || 1` forçait 1 même pour 0 -> tous marqués.
  expect(out.insufficient_data).toBe(0)
  expect(out.zero_data_rescue).toBe(false)
  expect(out.is_low_data_prediction).toBe(false)
  expect(out.enriched.insufficient_data).toBe(0)
  expect(out.enriched.is_low_data_prediction).toBe(false)
})

test('Prio3 : marquage low-data correct — insufficient_data=1 -> 1/true', async () => {
  setMock()
  const out = await enrichOne({ homeTeam: 'A', awayTeam: 'B', league: 'E0', insufficient_data: 1 })
  expect(out.insufficient_data).toBe(1)
  expect(out.zero_data_rescue).toBe(true)
  expect(out.is_low_data_prediction).toBe(true)
  expect(out.enriched.zero_data_rescue).toBe(true)
})
