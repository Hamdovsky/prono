/**
 * deriveXgFrom1X2 — reconstruction des attendus de buts depuis le 1X2.
 *
 * Contexte : E105. 11 matchs réglés sur 22 n'avaient aucun xG, donc leur
 * `expected_score` restait le défaut Python `'1 - 1'` — un score jamais calculé.
 */
const { deriveXgFrom1X2, expectedScoreFromXg, probs1x2 } = require('../core/utils/deriveXgFrom1X2')

describe('deriveXgFrom1X2', () => {
  it('retourne null sans probabilites exploitables', () => {
    expect(deriveXgFrom1X2(null, null, null)).toBeNull()
    expect(deriveXgFrom1X2(0, 0, 0)).toBeNull()
    expect(deriveXgFrom1X2('abc', 'def', 'ghi')).toBeNull()
  })

  it('reconstruit un match equilibre', () => {
    const r = deriveXgFrom1X2(0.394, 0.27, 0.337)
    expect(r).not.toBeNull()
    expect(r.homeXg).toBeCloseTo(1.3, 1)
    expect(r.awayXg).toBeCloseTo(1.2, 1)
    expect(r.error).toBeLessThan(1e-3)
  })

  it('reconstruit un domicile dominant', () => {
    const r = deriveXgFrom1X2(0.504, 0.262, 0.234)
    expect(r.homeXg).toBeGreaterThan(r.awayXg)
    expect(r.homeXg).toBeCloseTo(1.5, 1)
  })

  it('reconstruit un exterieur dominant', () => {
    const r = deriveXgFrom1X2(0.277, 0.252, 0.471)
    expect(r.awayXg).toBeGreaterThan(r.homeXg)
  })

  it('reproduit fidelement le triplet 1X2 fourni', () => {
    const r = deriveXgFrom1X2(0.466, 0.255, 0.279)
    expect(r.reconstructed.H).toBeCloseTo(0.466, 2)
    expect(r.reconstructed.D).toBeCloseTo(0.255, 2)
    expect(r.reconstructed.A).toBeCloseTo(0.279, 2)
  })

  it('accepte des pourcentages (0..100) comme des fractions', () => {
    const a = deriveXgFrom1X2(39.4, 27.0, 33.7)
    const b = deriveXgFrom1X2(0.394, 0.27, 0.337)
    expect(a.homeXg).toBeCloseTo(b.homeXg, 5)
    expect(a.awayXg).toBeCloseTo(b.awayXg, 5)
  })

  it('reste symetrique : permuter domicile/exterieur permute les xG', () => {
    const r = deriveXgFrom1X2(0.6, 0.25, 0.15)
    const s = deriveXgFrom1X2(0.15, 0.25, 0.6)
    expect(r.homeXg).toBeCloseTo(s.awayXg, 5)
    expect(r.awayXg).toBeCloseTo(s.homeXg, 5)
  })

  it('reagit correctement a une distribution plate (proche d-equilibre)', () => {
    const r = deriveXgFrom1X2(0.34, 0.33, 0.33)
    expect(Math.abs(r.homeXg - r.awayXg)).toBeLessThan(0.3)
  })

  it('normalise un triplet dont la somme depasse 1', () => {
    const r = deriveXgFrom1X2(39.4, 27.0, 33.7)
    expect(r.error).toBeLessThan(1e-3)
  })
})

describe('expectedScoreFromXg', () => {
  it('formate le score attendu', () => {
    expect(expectedScoreFromXg(1.6, 1.1)).toBe('2 - 1')
    expect(expectedScoreFromXg(2.4, 0.3)).toBe('2 - 0')
    expect(expectedScoreFromXg(0.8, 1.9)).toBe('1 - 2')
  })

  it('refuse de fabriquer un score sans xG exploitable', () => {
    // Point clé : ne jamais produire '1 - 1' par défaut, c'est exactement le
    // placeholder que ce correctif cherche à éliminer.
    expect(expectedScoreFromXg(null, null)).toBeNull()
    expect(expectedScoreFromXg(0, 0)).toBeNull()
    expect(expectedScoreFromXg('x', 'y')).toBeNull()
  })
})

describe('probs1x2 — cohérence poisson', () => {
  it('la somme vaut 1', () => {
    const q = probs1x2(1.4, 1.1)
    expect(q.H + q.D + q.A).toBeCloseTo(1, 6)
  })

  it('un profil symetrique donne autant de nul que de victoire chaque camp', () => {
    const q = probs1x2(1.3, 1.3)
    expect(q.H).toBeCloseTo(q.A, 6)
  })
})