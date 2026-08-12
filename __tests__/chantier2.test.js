/**
 * Chantier 2 (ÉTAPE 2 audit) — path PENDING : fix structurel du HONESTY GATE
 *
 * Le bug : resultData est construit par spread de l'état précédent ({ ...m, ... }) et
 * la branche "suffisante" ne réinitialisait pas risk_label / enriched.sufficient —
 * un match passé par une passe insuffisante puis suffisante gardait
 * risk_label:"PENDING" + sufficient:true (contradiction). Le fix rend les resets
 * SYMÉTRIQUES : chaque passe écrit tous les champs dérivés du verdict.
 *
 * Tests : module pur core/honestyGate.js — pas de dépendances lourdes.
 */

const { applyHonestyGate } = require('../core/honestyGate')

function baseResult(overrides = {}) {
  return {
    success: true,
    insufficient_data: 0,
    verdict: 'SAFE',
    risk_label: 'PENDING', // hérité d'une passe précédente (stale via ...m)
    prediction: '1',
    confidence: 65,
    odds_home: 2.4,
    odds_draw: 3.1,
    odds_away: 3.4,
    odds_source: 'flashscore',
    draw_value_bet: false,
    sufficient: true,
    quant: {
      main_pick: '1',
      risk_label: 'SAFE',
      all_picks: [{ cat: 'match_result', val: '1' }],
      markets: { match_result: { '1': {} } },
      ev_score: 0.4,
      edge_score: 0.15,
      massive_edge: false,
    },
    enriched: {
      winner: '1',
      verdict: 'SAFE',
      sufficient: false, // hérité d'une passe précédente (stale)
      prediction: null,
      insufficient_data: 1,
      main_predictions: [{ label: '1' }],
    },
    ...overrides,
  }
}

describe('honestyGate — passe insuffisante', () => {
  test('neutralise pick/odds/value et pose un verdict PENDING cohérent', () => {
    const rd = applyHonestyGate(baseResult({ prediction: '1' }), {
      insufficient: 1,
      hasRealOdds: true,
      oddsSynthetic: false,
    })
    expect(rd.sufficient).toBe(false)
    expect(rd.verdict).toBe('PENDING')
    expect(rd.risk_label).toBe('PENDING')
    expect(rd.prediction).toBeNull()
    expect(rd.odds_home).toBeNull()
    expect(rd.quant.main_pick).toBeNull()
    expect(rd.quant.ev_score).toBe(0)
    expect(rd.quant.markets).toEqual({})
    // enriched synchronisé (reset complet, pas d'héritage)
    expect(rd.enriched.sufficient).toBe(false)
    expect(rd.enriched.risk_label).toBe('PENDING')
    expect(rd.enriched.prediction).toBeNull()
    expect(rd.enriched.insufficient_data).toBe(1)
    expect(rd.enriched.verdict).toBe('PENDING')
    expect(rd.enriched.main_predictions).toEqual([])
  })
})

describe('honestyGate — passe suffisante APRÈS une passe insuffisante (la contradiction)', () => {
  test('risk_label et enriched.sufficient sont réinitialisés, pas hérités', () => {
    // Simule la passe N+1 : le spread { ...m } a ramené risk_label='PENDING' et
    // enriched.sufficient=false de la passe N, mais la passe courante est suffisante.
    const rd = applyHonestyGate(baseResult(), {
      insufficient: 0,
      hasRealOdds: true,
      oddsSynthetic: false,
    })
    expect(rd.sufficient).toBe(true)
    expect(rd.risk_label).toBe('SAFE') // verdict courant, PAS 'PENDING' hérité
    expect(rd.risk_label).not.toBe('PENDING')
    expect(rd.verdict).toBe('SAFE')
    expect(rd.prediction).toBe('1') // pick conservé
    expect(rd.enriched.sufficient).toBe(true) // PAS false hérité
    expect(rd.enriched.risk_label).toBe('SAFE')
    expect(rd.enriched.insufficient_data).toBe(0)
    expect(rd.enriched.verdict).toBe('SAFE')
    // cotes réelles → value conservée
    expect(rd.quant.ev_score).toBe(0.4)
    expect(rd.odds_home).toBe(2.4)
  })

  test('STABLE si le quant a downgradé le risque', () => {
    const rd = applyHonestyGate(baseResult({ quant: { ...baseResult().quant, risk_label: 'STABLE' }, verdict: 'STABLE' }), {
      insufficient: 0,
      hasRealOdds: true,
      oddsSynthetic: false,
    })
    expect(rd.risk_label).toBe('STABLE')
    expect(rd.enriched.risk_label).toBe('STABLE')
  })
})

describe('honestyGate — suffisant SANS cotes réelles', () => {
  test('pick conservé, value/edge neutralisés, odds null', () => {
    const rd = applyHonestyGate(baseResult(), {
      insufficient: 0,
      hasRealOdds: false,
      oddsSynthetic: true,
    })
    expect(rd.sufficient).toBe(true)
    expect(rd.prediction).toBe('1') // le pick modèle n'est pas jeté
    expect(rd.quant.ev_score).toBe(0)
    expect(rd.quant.edge_score).toBe(0)
    expect(rd.odds_home).toBeNull()
    expect(rd.odds_source).toBe('synthetic')
    expect(rd.risk_label).toBe('SAFE')
    expect(rd.enriched.sufficient).toBe(true)
  })
})
