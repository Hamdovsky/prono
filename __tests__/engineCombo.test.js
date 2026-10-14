/**
 * E93 — Combo GG + Over 2.5 : calcul moteur Node (StatisticalEngine) et
 * exposition via calculatePoissonProbs (bridge QuantumQuantEngine).
 * Le combo est borné (inégalités de Fréchet) entre les marginales BTTS et O2.5.
 */
const StatisticalEngine = require('../core/services/StatisticalEngine')

describe('StatisticalEngine — combo GG + Over 2.5', () => {
  const S = StatisticalEngine.default || StatisticalEngine

  test('calculateMarketProbs expose btts_over25 borné (Fréchet)', () => {
    const full = S.calculateMarketProbs(1.6, 1.3, {})
    const btts = full.btts.yes
    const ov = full.ou[2.5]
    expect(typeof full.btts_over25).toBe('number')
    expect(full.btts_over25).toBeGreaterThanOrEqual(0)
    expect(full.btts_over25).toBeLessThanOrEqual(1)
    expect(full.btts_over25).toBeLessThanOrEqual(btts + 1e-9)
    expect(full.btts_over25).toBeLessThanOrEqual(ov + 1e-9)
    expect(full.btts_over25).toBeGreaterThanOrEqual(Math.max(0, btts + ov - 1) - 1e-9)
  })

  test('calculatePoissonProbs propage btts_over25 (bridge QuantumQuantEngine)', () => {
    const p = S.calculatePoissonProbs(1.6, 1.3, {})
    expect(typeof p.btts_over25).toBe('number')
    expect(Number.isFinite(p.btts_over25)).toBe(true)
  })

  test('match très offensif : combo > match défensif', () => {
    const off = S.calculateMarketProbs(2.4, 2.2, {}).btts_over25
    const def = S.calculateMarketProbs(0.7, 0.6, {}).btts_over25
    expect(off).toBeGreaterThan(def)
  })
})
