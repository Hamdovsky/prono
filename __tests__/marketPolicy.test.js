/**
 * marketPolicy — picks au temps T (BTTS / Corners / HT)
 */
const { deriveBttsPick, deriveCornerPick, deriveHTPick, _expectedTotalGoals } = require('../core/marketPolicy')

describe('marketPolicy picks', () => {
  test('deriveBttsPick : YES si proba >= 50', () => {
    expect(deriveBttsPick({ btts_prob: 62 }).bttsPick).toBe('BTTS YES')
    expect(deriveBttsPick({ btts_prob: 38 }).bttsPick).toBe('BTTS NO')
    expect(deriveBttsPick({}).bttsPick).toBeNull()
  })

  test('deriveCornerPick : OVER/UNDER 9.5 selon expected_corners', () => {
    const over = deriveCornerPick({ expected_corners: 11.0 })
    expect(over.cornerPick).toBe('CORNERS OVER 9.5')
    const under = deriveCornerPick({ expected_corners: 7.0 })
    expect(under.cornerPick).toBe('CORNERS UNDER 9.5')
    expect(deriveCornerPick({}).cornerPick).toBeNull()
  })

  test('deriveHTPick : Over si ht_goal_prob modele eleve', () => {
    expect(deriveHTPick({ ht_goal_prob: 0.72 }).htPick).toBe('HT OVER 0.5')
    expect(deriveHTPick({ ht_goal_prob: 0.30 }).htPick).toBe('HT UNDER 0.5')
  })

  test('deriveHTPick : fallback prior archive (E0=0.70 -> OVER)', () => {
    // aucune proba modele : le prior appris par ligue (E0=0.7002) donne OVER
    const r = deriveHTPick({ league: 'E0' })
    expect(r.htPick).toBe('HT OVER 0.5')
    expect(r.htProb).toBeCloseTo(70.0, 0)
  })

  test('deriveHTPick : null si aucune source ET pas de prior', () => {
    // force un prior inexistant : league inconnu mais global dispo -> OVER quand meme
    expect(deriveHTPick({}).htPick).toBe('HT OVER 0.5')
  })
})

describe('deriveHTPick — HT_MODEL flag (E24 Phase 4a)', () => {
  const prev = process.env.HT_MODEL
  afterEach(() => { if (prev === undefined) delete process.env.HT_MODEL; else process.env.HT_MODEL = prev })

  test('_expectedTotalGoals : parse expected_score', () => {
    expect(_expectedTotalGoals({ expected_score: '2-1' })).toBe(3)
    expect(_expectedTotalGoals({ expected_score: '0:0' })).toBe(0)
    expect(_expectedTotalGoals({ expected_total_goals: 2.7 })).toBe(2.7)
    expect(_expectedTotalGoals({})).toBeNull()
  })

  test('flag OFF (défaut) : aucun effet sur le comportement historique', () => {
    delete process.env.HT_MODEL
    const r = deriveHTPick({ expected_score: '0-0' })
    expect(r.htPick).toBe('HT OVER 0.5')   // prior 0.69 → OVER (attendu)
    expect(r.htProb).toBeCloseTo(69.4, 0)
  })

  test('flag ON : prob calculée depuis expected goals, pas un prior constant', () => {
    process.env.HT_MODEL = 'on'
    const over = deriveHTPick({ expected_score: '3-1' })   // et=4 → P ≈ 83 %
    expect(over.htPick).toBe('HT OVER 0.5')
    expect(over.htProb).toBeGreaterThan(70)
    expect(over.htProb).not.toBeCloseTo(69.4, 1)          // distinct du prior
    const under = deriveHTPick({ expected_score: '0-0' }) // et=0 → P ≈ 0 → UNDER
    expect(under.htPick).toBe('HT UNDER 0.5')
  })

  test('flag ON : quant/ht_goal_prob gardent la priorité sur l\'estimation', () => {
    process.env.HT_MODEL = 'on'
    expect(deriveHTPick({ ht_goal_prob: 0.30, expected_score: '3-0' }).htPick).toBe('HT UNDER 0.5')
    expect(deriveHTPick({ quant: { markets: { ht: { goal_yes: 0.72 } } }, expected_score: '0-0' }).htPick).toBe('HT OVER 0.5')
  })
})
