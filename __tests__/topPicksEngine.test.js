const { _internal } = require('../services/topPicksEngine')
const { buildCandidates, noBetOverconfident, computeQualityScore } = _internal

describe('topPicksEngine — buildCandidates', () => {
  it('construit un candidat 1X2 quand les cotes réelles existent', () => {
    const m = {
      id: 1,
      homeTeam: 'Lyon',
      awayTeam: 'Nantes',
      league: 'Ligue 1',
      home_win_probability: 60,
      draw_probability: 25,
      away_win_probability: 15,
      odds_home: 2.0,
      odds_draw: 3.4,
      odds_away: 4.0,
      insufficient_data: 0,
    }
    const candidates = buildCandidates(m)
    expect(candidates.length).toBe(1)
    const c = candidates[0]
    expect(c.marketType).toBe('1X2')
    expect(c.recommendedPick).toBe('1')
    expect(c.odds).toBe(2.0)
    expect(c.modelProb).toBe(60)
    expect(c.edge).toBeGreaterThanOrEqual(5)
    expect(c.ev).toBeGreaterThanOrEqual(0.05)
    expect(c.kelly).toBeGreaterThan(0)
  })

  it('construit un candidat Over 2.5 depuis quant.markets', () => {
    const m = {
      id: 2,
      homeTeam: 'PSG',
      awayTeam: 'Metz',
      league: 'Ligue 1',
      home_win_probability: 55,
      draw_probability: 25,
      away_win_probability: 20,
      ou_25_prob: 65,
      quant: { markets: { over_under: { 'O2.5': { odds: 1.90, prob: 0.65 }, 'U2.5': { odds: 1.95 } } } },
      insufficient_data: 0,
    }
    const candidates = buildCandidates(m)
    const over = candidates.find((c) => c.marketType === 'Over 2.5')
    expect(over).toBeDefined()
    expect(over.odds).toBe(1.9)
    expect(over.modelProb).toBe(65)
    expect(over.recommendedPick).toBe('Over 2.5')
  })

  it('retourne [] sans cotes réelles (top-level ni quant)', () => {
    const m = { id: 3, homeTeam: 'A', awayTeam: 'B', league: 'X' }
    expect(buildCandidates(m)).toEqual([])
  })
})

describe('topPicksEngine — noBetOverconfident (guards de sécurité)', () => {
  it('veto si proba modèle trop haute (> 78%)', () => {
    const r = noBetOverconfident({
      modelProb: 82, fairProb: 50, odds: 1.5, kelly: 3, match: { insufficient_data: 0 },
    })
    expect(r.veto).toBe(true)
    expect(r.reason).toContain('overconfident')
  })

  it('veto si écart modèle / marché trop grand (> 25 pts)', () => {
    const r = noBetOverconfident({
      modelProb: 70, fairProb: 40, odds: 1.7, kelly: 2, match: { insufficient_data: 0 },
    })
    expect(r.veto).toBe(true)
  })

  it('veto si pas de Kelly positif', () => {
    const r = noBetOverconfident({ modelProb: 60, fairProb: 55, odds: 2.0, kelly: 0, match: {} })
    expect(r.veto).toBe(true)
    expect(r.reason).toBe('no_positive_kelly')
  })

  it('veto si données insuffisantes (pas de cotes réelles)', () => {
    const r = noBetOverconfident({ modelProb: 60, fairProb: 55, odds: 2.0, kelly: 2, match: { insufficient_data: 1 } })
    expect(r.veto).toBe(true)
    expect(r.reason).toBe('insufficient_data')
  })

  it('accepte un candidat calibré et solide', () => {
    const r = noBetOverconfident({
      modelProb: 62, fairProb: 55, odds: 1.9, kelly: 2.5, match: { insufficient_data: 0 },
    })
    expect(r.veto).toBe(false)
  })
})

describe('topPicksEngine — computeQualityScore', () => {
  it('préfère les signaux stables + edge élevé', () => {
    const mStrong = {
      home_win_probability: 68, draw_probability: 20, away_win_probability: 12,
    }
    const mWeak = {
      home_win_probability: 55, draw_probability: 45, away_win_probability: 0,
    }
    const cStrong = { modelProb: 68, edge: 10, ev: 0.15, kelly: 4 }
    const cWeak = { modelProb: 55, edge: 5.2, ev: 0.05, kelly: 1 }

    const sStrong = computeQualityScore(mStrong, cStrong, { adjustedConfidence: 68 })
    const sWeak = computeQualityScore(mWeak, cWeak, { adjustedConfidence: 55 })
    expect(sStrong.qualityScore).toBeGreaterThan(sWeak.qualityScore)
  })
})
