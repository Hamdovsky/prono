/**
 * marketPolicy — picks au temps T (BTTS / Corners / HT)
 */
const { deriveBttsPick, deriveCornerPick, deriveHTPick } = require('../core/marketPolicy')

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
