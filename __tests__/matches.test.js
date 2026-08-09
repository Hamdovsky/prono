/**
 * API Routes Unit Tests - Matches
 * Tests for routes/matches.js - Upcoming matches, market edge, refresh endpoints
 */

jest.mock('../core/speedCache', () => {
  const mockInvalidate = jest.fn()
  const mockSpeedCache = jest.fn(() => (req, res, next) => next())
  mockSpeedCache.invalidate = mockInvalidate
  mockSpeedCache.clearCache = jest.fn()
  return { speedCache: mockSpeedCache, invalidateCache: mockInvalidate }
})

jest.mock('../core/enriched_predictions', () => ({
  enrichMatch: jest.fn((match) => Promise.resolve(match)),
  fastEnrichMatch: jest.fn((match) =>
    Promise.resolve({
      ...match,
      home_win_probability: match.home_win_probability || 50,
      draw_probability: match.draw_probability || 25,
      away_win_probability: match.away_win_probability || 25,
      expected_score: '1 - 1',
      enriched: { winner: 'HOME', winnerProbability: 50 },
    })
  ),
}))

jest.mock('../services/oddsMovementService', () => ({
  getSteamForMatch: jest.fn(),
  get24hMovement: jest.fn(),
  snapshotOdds: jest.fn(),
  detectBookmakerTrap: jest.fn(),
}))

jest.mock('../src/services/ValueBetEngine', () => ({
  analyzeValue: jest.fn(),
}))

jest.mock('../services/integrity_service', () => ({
  analyzeMatch: jest.fn(),
}))

jest.mock('../src/services/newsService', () => {
  function MockCache() {
    this.get = jest.fn()
    this.set = jest.fn()
  }
  return {
    getMatchIntelligence: jest.fn().mockResolvedValue(null),
    NewsCache: MockCache,
  }
})

jest.mock('../services/LiveGoalPredictor', () => ({
  analyzeLiveMatch: jest.fn(() => ({})),
}))

jest.mock('../services/liveMatchService', () => ({
  getActiveMatches: jest.fn(() => []),
}))

jest.mock('../services/openMeteoService', () => ({
  isAvailable: jest.fn(() => true),
  fetchByCity: jest.fn().mockResolvedValue({
    current: { temperature_2m: 8, relative_humidity_2m: 90, weather_code: 63, wind_speed_10m: 20 },
  }),
  extractWeatherInfo: jest.fn((d) =>
    d?.current
      ? {
          temp: d.current.temperature_2m,
          humidity: d.current.relative_humidity_2m,
          description: 'Light rain',
        }
      : null
  ),
}))

const request = require('supertest')
const express = require('express')
const matchesRouter = require('../routes/matches')
const database = require('../core/database')
const StatisticalEngine = require('../core/services/StatisticalEngine')

const { invalidateCache } = require('../core/speedCache')
const { getSteamForMatch } = require('../services/oddsMovementService')
const ValueBetEngine = require('../src/services/ValueBetEngine')
const IntegrityService = require('../services/integrity_service')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/matches', matchesRouter)
})

describe('Matches API Routes', () => {
  describe('GET /api/matches/upcoming', () => {
    const allUpcoming = (body) => [...(body.elite || []), ...(body.fallback_pool || [])]

    it('should return upcoming matches in elite list', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'match-1',
          homeTeam: 'Barcelona',
          awayTeam: 'Real Madrid',
          league: 'La Liga',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 1.95,
          odds_draw: 3.4,
          odds_away: 3.8,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body.elite)).toBe(true)
      expect(allUpcoming(response.body).length).toBeGreaterThan(0)

      jest.restoreAllMocks()
    })

    it('should filter out reserve/youth teams', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: '1',
          homeTeam: 'Barcelona II',
          awayTeam: 'Real Madrid',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 2.0,
          odds_away: 3.0,
        },
        {
          id: '2',
          homeTeam: 'Bayern Munich',
          awayTeam: 'Dortmund II',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 2.0,
          odds_draw: 3.0,
          odds_away: 3.0,
        },
        {
          id: '3',
          homeTeam: 'Liverpool',
          awayTeam: 'Chelsea',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 2.0,
          odds_draw: 3.0,
          odds_away: 3.0,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all.some((m) => m.homeTeam.includes('II') || m.awayTeam.includes('II'))).toBe(false)
      expect(all.some((m) => m.homeTeam === 'Liverpool')).toBe(true)

      jest.restoreAllMocks()
    })

    it('should filter out matches with very low odds (< 1.10)', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'm1',
          homeTeam: 'Alpha FC',
          awayTeam: 'Beta United',
          odds_home: 1.05,
          odds_draw: 8.0,
          odds_away: 10.0,
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        },
        {
          id: 'm2',
          homeTeam: 'Gamma City',
          awayTeam: 'Delta Rovers',
          odds_home: 1.85,
          odds_draw: 3.4,
          odds_away: 3.6,
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all.length).toBe(1)
      expect(all[0].id).toBe('m2')

      jest.restoreAllMocks()
    })

    it('should deduplicate matches by team pair', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'dup-a',
          homeTeam: 'Alpha FC',
          awayTeam: 'Beta United',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 2.0,
          odds_away: 3.0,
        },
        {
          id: 'dup-b',
          homeTeam: 'Alpha FC',
          awayTeam: 'Beta United',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
          odds_home: 2.0,
          odds_away: 3.0,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      expect(allUpcoming(response.body).length).toBe(1)

      jest.restoreAllMocks()
    })

    it('should apply date window filter', async () => {
      const nowSec = Math.floor(Date.now() / 1000)
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'old',
          startTimestamp: nowSec - 86400,
          homeTeam: 'Old',
          awayTeam: 'Match',
          league: 'Test',
          odds_home: 2.0,
          odds_away: 3.0,
        },
        {
          id: 'future',
          startTimestamp: nowSec + 7 * 86400,
          homeTeam: 'Far Future',
          awayTeam: 'Match',
          league: 'Test',
          odds_home: 2.0,
          odds_away: 3.0,
        },
        {
          id: 'valid',
          startTimestamp: nowSec + 3600,
          homeTeam: 'Current',
          awayTeam: 'Match',
          league: 'Test',
          odds_home: 2.0,
          odds_away: 3.0,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all.some((m) => m.id === 'valid')).toBe(true)
      expect(all.some((m) => m.id === 'old' || m.id === 'future')).toBe(false)

      jest.restoreAllMocks()
    })

    it('should expose engine probabilities for matches without predictions', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'unenriched',
          homeTeam: 'Team X',
          awayTeam: 'Team Y',
          league: 'Test',
          odds_home: 1.85,
          odds_draw: 3.4,
          odds_away: 4.2,
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        },
      ])

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all[0].home_win_probability).toBeDefined()

      jest.restoreAllMocks()
    })

    it('should give every match a statistical verdict + corners even without odds', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'no-odds',
          homeTeam: 'FC Nord',
          awayTeam: 'FC Sud',
          league: 'Test',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        },
      ])
      jest.spyOn(StatisticalEngine, 'getMatchXG').mockReturnValue({ h: 1.4, a: 1.1 })

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all.length).toBe(1)
      const m = all[0]
      expect(m.insufficient_data).toBe(1)
      expect(parseFloat(m.home_win_probability) || 0).toBeGreaterThan(0)
      expect(parseFloat(m.draw_probability) || 0).toBeGreaterThan(0)
      expect(parseFloat(m.away_win_probability) || 0).toBeGreaterThan(0)
      expect(parseFloat(m.btts_prob) || 0).toBeGreaterThan(0)
      expect(parseFloat(m.ou_25_prob) || 0).toBeGreaterThan(0)
      expect(m.cornersVerdict).toBeDefined()
      expect(m.cornersVerdict.expectedTotal).toBeGreaterThan(0)

      jest.restoreAllMocks()
    })

    it('should JIT-fill missing weather via open-meteo so O/U reflects real conditions', async () => {
      const openMeteo = require('../services/openMeteoService')
      openMeteo.fetchByCity.mockClear()
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'rainy',
          homeTeam: 'FC Pluie',
          awayTeam: 'FC Vent',
          league: 'Test',
          country_iso: 'FR',
          startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        },
      ])
      jest.spyOn(StatisticalEngine, 'getMatchXG').mockReturnValue({ h: 1.4, a: 1.1 })

      const response = await request(app).get('/api/matches/upcoming')
      expect(response.status).toBe(200)
      const all = allUpcoming(response.body)
      expect(all.length).toBe(1)
      const m = all[0]
      expect(openMeteo.fetchByCity).toHaveBeenCalled()
      expect(m.weather_temp).toBe(8)
      expect(m.weather_desc).toContain('rain')
      expect(m.weather_humidity).toBe(90)

      jest.restoreAllMocks()
    })
  })

  describe('POST /api/matches/refresh-upcoming', () => {
    it('should invalidate cache and return success', async () => {
      const response = await request(app).post('/api/matches/refresh-upcoming')
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)
      expect(invalidateCache).toHaveBeenCalledWith('upcoming')
    })
  })

  describe('GET /api/matches/odds/steam/:matchId', () => {
    it('should return steam odds for a match', async () => {
      const mockSteam = { homeOdds: 1.9, drawOdds: 3.5, awayOdds: 3.9, steam_detected: true }
      getSteamForMatch.mockReturnValue(mockSteam)

      const response = await request(app).get('/api/matches/odds/steam/test-match-123')
      expect(response.status).toBe(200)
      expect(response.body).toEqual(mockSteam)
    })
  })

  describe('GET /api/matches/market/edge', () => {
    it('should return value bets with edge opportunities', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'value-1',
          homeTeam: 'Alpha FC',
          awayTeam: 'Beta United',
          league: 'Test League',
          home_win_probability: 60,
          draw_probability: 22,
          away_win_probability: 18,
          odds_home: 2.0,
          odds_draw: 3.2,
          odds_away: 3.5,
          source: 'africanobet',
        },
      ])

      ValueBetEngine.analyzeValue.mockReturnValue({
        hasValue: true,
        best: { edge: 5.5, kelly: 0.02, selection: 'home' },
      })

      IntegrityService.analyzeMatch.mockResolvedValue({
        score: 85,
        trafficLight: 'GREEN',
        recommendation: 'Clear',
        strategicTags: ['high-value'],
      })

      const response = await request(app).get('/api/matches/market/edge')
      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body[0]).toHaveProperty('analysis')
      expect(response.body[0]).toHaveProperty('integrity')

      jest.restoreAllMocks()
    })

    it('should return empty array when no value bets found', async () => {
      jest.spyOn(database, 'getMatchesByStatuses').mockResolvedValue([
        {
          id: 'no-value',
          homeTeam: 'Alpha FC',
          awayTeam: 'Beta United',
          league: 'Test',
          home_win_probability: 50,
          odds_home: 2.0,
          source: 'africanobet',
        },
      ])

      ValueBetEngine.analyzeValue.mockReturnValue({ hasValue: false })

      const response = await request(app).get('/api/matches/market/edge')
      expect(response.status).toBe(200)
      expect(response.body).toEqual([])

      jest.restoreAllMocks()
    })
  })

  describe('POST /api/matches/refresh-lineups/:id', () => {
    it('should refresh lineups for a match', async () => {
      const matchId = 'test-match-lineup'
      jest.spyOn(database, 'getMatchById').mockResolvedValue({
        id: matchId,
        id_sofa: '12345',
        homeTeam: 'Alpha FC',
        awayTeam: 'Beta United',
        startTimestamp: Date.now(),
      })

      const response = await request(app).post(`/api/matches/refresh-lineups/${matchId}`)
      expect(response.status).toBe(200)
      expect(response.body.success).toBe(true)

      jest.restoreAllMocks()
    })

    it('should return 404 for non-existent match', async () => {
      jest.spyOn(database, 'getMatchById').mockResolvedValue(null)

      const response = await request(app).post('/api/matches/refresh-lineups/nonexistent')
      expect(response.status).toBe(404)

      jest.restoreAllMocks()
    })
  })
})
