// E93 : marche combine "GG + Over 2.5" (btts_over25) — classification registry.
// Le combo doit etre reconnu AVANT total_goals/btts (le libelle contient "Over 2.5").
const { lookup } = require('../core/market/registry')
const { normalize } = require('../core/market/normalizer')
const { validateAndBuild } = require('../core/market/validator')

function norm(rawName, outcomeName = 'Yes', odds = 1.9) {
  return normalize({
    source: 'sofascore',
    rawName,
    outcomes: [{ name: outcomeName, odds }],
  })
}

describe('E93 — combo GG + Over 2.5 (registry btts_over25)', () => {
  test('lookup renvoie le marche combo (categorie combo)', () => {
    const def = lookup('btts_over25')
    expect(def).toBeTruthy()
    expect(def.category).toBe('combo')
    expect(def.defaultLine).toBe(2.5)
  })

  test('"GG + Over 2.5" -> btts_over25 (pas total_goals)', () => {
    const r = norm('GG + Over 2.5')
    expect(r.market_id).toBe('btts_over25')
    expect(r.line).toBe(2.5)
    expect(r.outcomes[0].selection).toBe('yes')
  })

  test('"Both Teams To Score & Over 2.5" -> btts_over25', () => {
    expect(norm('Both Teams To Score & Over 2.5').market_id).toBe('btts_over25')
  })

  test('"Over 2.5 & BTTS" (ordre inverse) -> btts_over25', () => {
    expect(norm('Over 2.5 & BTTS').market_id).toBe('btts_over25')
  })

  test('"Over/Under 2.5 Goals" reste total_goals (non capte par le combo)', () => {
    const r = norm('Over/Under 2.5 Goals', 'Over')
    expect(r.market_id).toBe('total_goals')
  })

  test('"Both Teams To Score" seul reste btts', () => {
    expect(norm('Both Teams To Score').market_id).toBe('btts')
  })

  test('validateAndBuild marque le combo usable (selection yes)', () => {
    const canonical = validateAndBuild(norm('GG + Over 2.5'))
    expect(canonical.length).toBe(1)
    expect(canonical[0].market_id).toBe('btts_over25')
    expect(canonical[0].usable).toBe(true)
  })
})
