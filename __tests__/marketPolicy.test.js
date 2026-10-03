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

/**
 * E79 : applyMarketPolicy était le garde-fou qui empêchait le 1X2 pur
 * d'atteindre la base, et il n'était testé dans AUCUN sens — ni activé, ni
 * désactivé. Une régression ici est silencieuse : les picks 1X2 reviennent
 * sans qu'aucun test ne bronche.
 *
 * DISABLE_PURE_1X2 est lu au chargement du module : il faut donc recharger le
 * module après avoir posé la variable.
 */
describe('applyMarketPolicy — masquage du 1X2 pur (E79)', () => {
  const P = {
    home_win_probability: 0.55,
    away_win_probability: 0.25,
  }

  function load(flag) {
    jest.resetModules()
    if (flag === undefined) delete process.env.DISABLE_PURE_1X2
    else process.env.DISABLE_PURE_1X2 = flag
    return require('../core/marketPolicy')
  }

  const prev = process.env.DISABLE_PURE_1X2
  afterAll(() => {
    if (prev === undefined) delete process.env.DISABLE_PURE_1X2
    else process.env.DISABLE_PURE_1X2 = prev
  })

  test('flag absent : le verdict 1X2 passe untouched (comportement historique)', () => {
    const { applyMarketPolicy, isPure1x2Disabled } = load(undefined)
    expect(isPure1x2Disabled()).toBe(false)
    for (const p of ['1', 'X', '2', '1x', ' 2 ']) {
      expect(applyMarketPolicy(p, P)).toEqual({ prediction: p, converted: false })
    }
  })

  test('flag OFF explicite : idem, la conversion ne doit rien changer', () => {
    const { applyMarketPolicy, isPure1x2Disabled } = load('false')
    expect(isPure1x2Disabled()).toBe(false)
    expect(applyMarketPolicy('1', P).converted).toBe(false)
  })

  test('flag ON : 1 -> 1X et 2 -> X2, originalPrediction conservé', () => {
    const { applyMarketPolicy, isPure1x2Disabled } = load('true')
    expect(isPure1x2Disabled()).toBe(true)
    expect(applyMarketPolicy('1', P)).toEqual({
      prediction: '1X',
      originalPrediction: '1',
      converted: true,
    })
    expect(applyMarketPolicy('2', P)).toEqual({
      prediction: 'X2',
      originalPrediction: '2',
      converted: true,
    })
  })

  test('flag ON : le nul part du côté le plus probable, jamais un « X » seul', () => {
    const { applyMarketPolicy } = load('true')
    // il n'existe pas de double chance « nul seul » : on prend le flanc dominant
    expect(applyMarketPolicy('X', P).prediction).toBe('1X')
    expect(applyMarketPolicy('X', { home_win_probability: 0.2, away_win_probability: 0.5 }).prediction)
      .toBe('X2')
  })

  test('flag ON : les marchés autres que 1X2 ne sont jamais touchés', () => {
    const { applyMarketPolicy } = load('true')
    for (const p of ['1X', 'X2', '12', 'BTTS YES', 'OVER 2.5']) {
      expect(applyMarketPolicy(p, P).converted).toBe(false)
    }
  })
})
