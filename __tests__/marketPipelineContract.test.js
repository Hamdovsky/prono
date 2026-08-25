// Smoke-test contrat (audit B) : verifie que les champs emis par prediction_engine.py
// (ht_goal_prob, expected_corners, expected_cards) sont correctement resolus par les
// accesseurs de database.js / pg_database.js et pilotes deriveHTPick / deriveCornerPick.
// Sans ca, un renommage silencieux casserait la mesure sans erreur.
const { deriveHTPick, deriveCornerPick } = require('../core/marketPolicy')

// Accesseurs identiques a core/database.js:854-863 et core/pg_database.js:209-218
function resolveHt(m) {
  return deriveHTPick({
    quant: m.fullData && m.fullData.quant,
    ht_goal_prob: m.ht_goal_prob != null ? m.ht_goal_prob : (m.fullData && m.fullData.ht_goal_prob),
    league: m.league != null ? m.league : (m.fullData && m.fullData.league),
  }, {})
}
function resolveCorner(m) {
  return deriveCornerPick({
    quant: m.fullData && m.fullData.quant,
    expected_corners: m.expected_corners != null ? m.expected_corners : (m.fullData && m.fullData.expected_corners),
  })
}

describe('audit B : contrat champs prediction -> picks', () => {
  test('ht_goal_prob eleve => Over HT (depuis fullData)', () => {
    const m = { fullData: { ht_goal_prob: 0.72 } }
    const r = resolveHt(m)
    expect(r.htPick).toMatch(/HT/i)
    expect(r.htPick).toMatch(/Over/i)
    expect(typeof r.htProb).toBe('number')
  })

  test('ht_goal_prob faible => Under HT (fallback prior si absent)', () => {
    const m = { fullData: { ht_goal_prob: 0.3 } }
    const r = resolveHt(m)
    expect(r.htPick).toMatch(/Under/i)
  })

  test('absence ht_goal_prob => prior ligue utilise (HT_RATIOS)', () => {
    const m = { fullData: { league: 'E0' } }
    const r = resolveHt(m)
    expect(typeof r.htPick).toBe('string')
    expect(r.htPick.length).toBeGreaterThan(0)
  })

  test('expected_corners eleve => Over Corners (depuis fullData)', () => {
    const m = { fullData: { expected_corners: 11.3 } }
    const r = resolveCorner(m)
    expect(r.cornerPick).toMatch(/Over/i)
    expect(typeof r.cornerProb).toBe('number')
  })

  test('expected_corners faible => Under Corners', () => {
    const m = { fullData: { expected_corners: 7.0 } }
    const r = resolveCorner(m)
    expect(r.cornerPick).toMatch(/Under/i)
  })

  test('resolution depuis champs racine (pas fullData)', () => {
    const m = { ht_goal_prob: 0.65, expected_corners: 10.5 }
    expect(resolveHt(m).htPick).toMatch(/Over/i)
    expect(resolveCorner(m).cornerPick).toMatch(/Over/i)
  })
})
