/**
 * Chantier 4 (ÉTAPE 2 audit) — PRIORITÉ 0 : fix enrichOne
 *
 * Le bug : enrichOne (ex-closure server.js) retournait probs + quant SANS
 * prediction/verdict/risk_label/confidence/market_scope → updatePredictions
 * héritait de la colonne staled ('1') au lieu de quant.main_pick (1X/O0.5/12).
 * Le fix : core/enrichOne.js écrit TOUS les champs dérivés (module pur,
 * dépendances injectables).
 */

const { enrichOne } = require('../core/enrichOne')

// Stub du moteur quant : reproduit le shape de QuantumQuantEngine.analyze
function fakeQuant(overrides = {}) {
  return {
    main_pick: '1X',
    secondary_pick: 'DC: 1X',
    ev_score: '0.25',
    edge_score: '0.12',
    risk_label: 'SAFE',
    expected_score: '1-1',
    confidence: 82,
    markets: {
      match_result: { 1: { prob: 0.48 }, X: { prob: 0.27 }, 2: { prob: 0.25 } },
      double_chance: { '1X': { prob: 0.75 }, X2: { prob: 0.52 }, '12': { prob: 0.73 } },
      over_under: { 'O2.5': { prob: 0.51 }, 'U2.5': { prob: 0.49 }, 'O3.5': { prob: 0.3 } },
      first_half: { 'O0.5': { prob: 0.72 }, 'O1.5': { prob: 0.4 } },
      btts: { YES: { prob: 0.56 }, NO: { prob: 0.44 } },
    },
    probs: { btts: 56, over25: 51, ht_goal: 72 },
    all_picks: [],
    ...overrides,
  }
}

function baseMatch(overrides = {}) {
  return {
    id: 'test_1',
    homeTeam: 'Team A',
    awayTeam: 'Team B',
    league: 'Test League',
    status: 'scheduled',
    prediction: '1', // stale colonne DB (le bug historique)
    odds_home: null,
    odds_draw: null,
    odds_away: null,
    insufficient_data: 1,
    ...overrides,
  }
}

describe('enrichOne — champs dérivés complets (PRIORITÉ 0)', () => {
  test('écrit prediction/verdict frais, jamais stale', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant() },
    })
    expect(result.prediction).toBe('1X')
    expect(result.verdict).toBe('SAFE')
    expect(result.risk_label).toBe('SAFE')
    expect(result.confidence).toBe(82)
    expect(result.sufficient).toBe(true)
  })

  test('prediction == quant.main_pick, sans normalisation 1X2 (1X reste 1X)', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant() },
    })
    expect(result.quant.main_pick).toBe('1X')
    expect(result.prediction).toBe(result.quant.main_pick)
  })

  test('market_scope dérivé via core/marketScope (double_chance → full_time_dc)', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant() },
    })
    expect(result.market_scope).toBe('full_time_dc')
  })

  test('O0.5 → first_half (marché HT détecté, pas évalué en full-time)', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant({ main_pick: 'O0.5' }) },
    })
    expect(result.prediction).toBe('O0.5')
    expect(result.market_scope).toBe('first_half')
  })

  test('O2.5 → full_time_ou', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant({ main_pick: 'O2.5' }) },
    })
    expect(result.market_scope).toBe('full_time_ou')
  })

  test('enriched sous-objet synchronisé (prediction/verdict/market_scope)', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant() },
    })
    expect(result.enriched.prediction).toBe('1X')
    expect(result.enriched.verdict).toBe('SAFE')
    expect(result.enriched.risk_label).toBe('SAFE')
    expect(result.enriched.sufficient).toBe(true)
    expect(result.enriched.market_scope).toBe('full_time_dc')
  })

  test('main_pick 1 → full_time_1x2', async () => {
    const result = await enrichOne(baseMatch(), {
      quantEngine: { analyze: () => fakeQuant({ main_pick: '1' }) },
    })
    expect(result.market_scope).toBe('full_time_1x2')
  })
})
