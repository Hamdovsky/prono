const { describe, it, expect, beforeEach } = require('@jest/globals')

const FIXTURE_PICKS = [
  {
    matchId: 'm1',
    marketType: '1X2',
    recommendedPick: '1',
    leagueName: 'Premier League',
    modelProbability: 62,
    odds: 2.1,
    edgePct: 8,
  },
  {
    matchId: 'm2',
    marketType: '1X2',
    recommendedPick: 'X',
    leagueName: 'Serie A',
    modelProbability: 50,
    odds: 2.5,
    edgePct: 7,
  },
  {
    matchId: 'm3',
    marketType: '1X2',
    recommendedPick: '2',
    leagueName: 'Ligue 1',
    modelProbability: 60,
    odds: 2.2,
    edgePct: 6,
  },
  {
    matchId: 'm4',
    marketType: '1X2',
    recommendedPick: '1',
    leagueName: 'Ekstraklasa',
    modelProbability: 58,
    odds: 2.4,
    edgePct: 5.5,
  },
  {
    matchId: 'm5',
    marketType: 'Over 2.5',
    recommendedPick: 'Over 2.5',
    leagueName: 'Premier League',
    modelProbability: 58,
    odds: 1.9,
    edgePct: 7,
  },
]

jest.mock('../services/topPicksEngine', () => ({
  selectTopPicksOfDay: jest.fn().mockResolvedValue({
    picks: FIXTURE_PICKS,
    generatedAt: '2026-01-01T00:00:00.000Z',
    analyzed: 5,
    rejected: [],
    filters: { edgePct: 5, ev: 0.05, probMin: 55, probMax: 75 },
  }),
}))

jest.mock('../core/database', () => ({
  db: {
    prepare: jest.fn(() => ({
      all: jest.fn().mockReturnValue([
        { league: 'Primera Division', accuracy: 0.61, total_cases: 120 },
        { league: 'Eredivisie', accuracy: 0.6, total_cases: 90 },
        { league: 'Liga NOS', accuracy: 0.55, total_cases: 200 },
        { league: 'Championship', accuracy: 0.65, total_cases: 10 },
      ]),
    })),
  },
}))

const proPlanEngine = require('../services/proPlanEngine')

describe('proPlanEngine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('n’accepte que le marché 1X2', async () => {
    const { picks } = await proPlanEngine.selectProPicks1X2({ limit: 5, days: 14 })
    expect(picks.length).toBeGreaterThan(0)
    for (const p of picks) {
      expect(p.marketType).toBe('1X2')
    }
  })

  it('règle du nul : X accepté seulement si proba >= 45% ET cote >= 3.0', () => {
    expect(proPlanEngine.isDrawAllowed('X', 50, 2.5)).toBe(false)
    expect(proPlanEngine.isDrawAllowed('X', 44, 3.2)).toBe(false)
    expect(proPlanEngine.isDrawAllowed('X', 50, 3.0)).toBe(true)
    expect(proPlanEngine.isDrawAllowed('1', 50, 2.5)).toBe(true)
    expect(proPlanEngine.isDrawAllowed('2', 0, 0)).toBe(true)
  })

  it('rejette un nul risqué (X @2.5) dans la sélection', async () => {
    const { picks } = await proPlanEngine.selectProPicks1X2({ limit: 5, days: 14 })
    const draw = picks.find((p) => p.recommendedPick === 'X')
    expect(draw).toBeUndefined()
  })

  it('rejette les ligues hors top-5 / non fiables', async () => {
    const { picks } = await proPlanEngine.selectProPicks1X2({ limit: 5, days: 14 })
    for (const p of picks) {
      expect(p.leagueName).not.toBe('Ekstraklasa')
    }
  })

  it('getReliableLeagues ne retient que acc >= 58% et samples >= 50', () => {
    const reliable = proPlanEngine.getReliableLeagues()
    expect(reliable.has('primera division')).toBe(true)
    expect(reliable.has('eredivisie')).toBe(true)
    expect(reliable.has('liga nos')).toBe(false)
    expect(reliable.has('championship')).toBe(false)
  })

  it('leagueAllowed : top-5, fiables (sous-chaîne), inconnues → false', () => {
    const reliable = new Set(['primera division', 'eredivisie'])
    expect(proPlanEngine.leagueAllowed('Premier League', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('La Liga Santander', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('Ligue 1', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('Eredivisie', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('Bundesliga', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('Serie A', reliable)).toBe(true)
    expect(proPlanEngine.leagueAllowed('Ekstraklasa', reliable)).toBe(false)
    expect(proPlanEngine.leagueAllowed('', reliable)).toBe(false)
    expect(proPlanEngine.leagueAllowed(null, reliable)).toBe(false)
  })

  it('respecte la limite demandée (1..10)', async () => {
    const { picks } = await proPlanEngine.selectProPicks1X2({ limit: 1, days: 14 })
    expect(picks.length).toBeLessThanOrEqual(1)
  })

  it('sélectionne bien le bon nombre de picks après filtres', async () => {
    const { picks } = await proPlanEngine.selectProPicks1X2({ limit: 5, days: 14 })
    expect(picks.map((p) => p.matchId)).toContain('m1')
    expect(picks.map((p) => p.matchId)).toContain('m3')
    expect(picks.length).toBe(2)
  })

  it('expose les règles de discipline dans les filtres', async () => {
    const { filters } = await proPlanEngine.selectProPicks1X2({ limit: 5, days: 14 })
    expect(filters.drawRule).toContain('45')
    expect(filters.leagues).toContain('top-5')
  })
})
