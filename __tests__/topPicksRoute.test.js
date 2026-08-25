const express = require('express')
const request = require('supertest')

jest.mock('../services/topPicksEngine', () => ({
  selectTopPicksOfDay: jest.fn().mockResolvedValue({
    picks: [
      {
        matchId: 1,
        homeTeam: 'Lyon',
        awayTeam: 'Nantes',
        leagueName: 'Ligue 1',
        matchTime: '2026-08-19T17:00:00.000Z',
        marketType: '1X2',
        recommendedPick: '1',
        odds: 2.0,
        modelProbability: 60,
        edgePct: 10,
        ev: 0.2,
        stakeRecommendation: '5%',
        reasoningSummary: 'Modèle 60% • Edge +10 pts vs cotes',
      },
    ],
    analyzed: 1,
    rejected: { filters: 0, veto: 0, overconfident: 0 },
    filters: { edgePct: 5, ev: 0.05, probMin: 55, probMax: 75 },
    generatedAt: '2026-08-19T10:00:00.000Z',
  }),
}))

const matchesRouter = require('../routes/matches')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api', matchesRouter)
})

describe('GET /api/top-picks/daily', () => {
  it('retourne les picks avec le payload documenté', async () => {
    const response = await request(app).get('/api/top-picks/daily')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.count).toBe(1)
    const pick = response.body.picks[0]
    expect(pick.matchId).toBe(1)
    expect(pick.homeTeam).toBe('Lyon')
    expect(pick.marketType).toBe('1X2')
    expect(pick.recommendedPick).toBe('1')
    expect(pick.edgePct).toBe(10)
    expect(pick.stakeRecommendation).toBe('5%')
    expect(typeof pick.reasoningSummary).toBe('string')
  })

  it('gère limit/days', async () => {
    const response = await request(app).get('/api/top-picks/daily?limit=3&days=7')
    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
  })
})
