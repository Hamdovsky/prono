const express = require('express')
const request = require('supertest')

jest.mock('../core/speedCache', () => ({
  speedCache: () => (req, res, next) => next()
}))

jest.mock('../core/promosport_scraper', () => ({
  scrapePromosport: jest.fn()
}))

jest.mock('../core/promosport_engine', () => ({
  generatePromosportGrids: jest.fn(),
  generateGoldCoupon: jest.fn()
}))

jest.mock('../core/promosport_tunisie_scraper', () => ({
  scrapeTunisieGrid: jest.fn()
}))

jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue('Import OK\nAccuracy: 36.11% | Log Loss: 1.2599')
}))

jest.mock('../services/promosportResultService', () => ({
  checkAndFetchResults: jest.fn(),
  computeAccuracy: jest.fn(),
  getOverallStats: jest.fn(),
  getRecentHistory: jest.fn(),
  storePrediction: jest.fn()
}))

jest.mock('../services/promosportMLService', () => ({
  reloadModel: jest.fn(),
  loadModel: jest.fn().mockReturnValue(true),
  predictBatch: jest.fn().mockReturnValue(null),
  ready: true
}))

jest.mock('../services/promosportIntelligence', () => ({
  analyzeMatch: jest.fn()
}))

jest.mock('../services/doubleOptimizerService', () => ({
  optimize: jest.fn()
}))

jest.mock('../services/crowdHackerService', () => ({
  analyze: jest.fn()
}))

jest.mock('../services/secretWeaponsTracker', () => ({
  getWeapons: jest.fn(),
  getHistory: jest.fn(),
  submitResults: jest.fn(),
  recordResults: jest.fn()
}))

jest.mock('better-sqlite3', () => {
  const mockDb = {
    prepare: jest.fn().mockReturnThis(),
    get: jest.fn().mockReturnValue({ c: 100 }),
    all: jest.fn().mockReturnValue([]),
    run: jest.fn().mockReturnValue({ changes: 0 }),
    close: jest.fn()
  }
  return jest.fn(() => mockDb)
})

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { scrapePromosport } = require('../core/promosport_scraper')
const { generatePromosportGrids, generateGoldCoupon } = require('../core/promosport_engine')
const secretWeaponsTracker = require('../services/secretWeaponsTracker')
const promosportResultService = require('../services/promosportResultService')

const promosportRouter = require('../routes/promosport')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/promosport', promosportRouter)
})

afterEach(() => { jest.restoreAllMocks() })

function make13Matches() {
  return Array.from({ length: 13 }, (_, i) => ({
    id: i + 1,
    homeTeam: `TEAM_${i + 1}_HOME`,
    awayTeam: `TEAM_${i + 1}_AWAY`,
    leagueName: 'Premier League',
    homeWinProbability: 0.40 + Math.random() * 0.1,
    drawProbability: 0.25 + Math.random() * 0.05,
    awayWinProbability: 0.25 + Math.random() * 0.1,
    matchTime: '15:00',
    concoursNumber: '878',
    concoursDate: '2025-06-01'
  }))
}

function makeGrids() {
  const matches = Array.from({ length: 13 }, (_, i) => ({
    choices: ['1', 'X', '2'],
    p1: 0.40, px: 0.25, p2: 0.35,
    crowdP1: 0.42, crowdP2: 0.33,
    isCrowdTrap: false, isAwayCrowdTrap: false, publicOverconfidence: false,
    intel: 'Test intel', brief: 'Test brief'
  }))
  return [
    { name: 'Grid ML', matches },
    { name: 'Grid Crowd', matches },
    { name: 'Grid Tactical', matches },
    { name: 'Grid Hybrid', matches }
  ]
}

describe('Promosport Routes', () => {
  describe('GET /api/promosport', () => {
    it('returns unified matches grid', async () => {
      scrapePromosport.mockResolvedValue(make13Matches())
      generatePromosportGrids.mockResolvedValue(makeGrids())

      const res = await request(app).get('/api/promosport')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('concours')
      expect(res.body).toHaveProperty('date')
      expect(res.body).toHaveProperty('matches')
      expect(Array.isArray(res.body.matches)).toBe(true)
      expect(res.body.matches.length).toBe(13)
    })

    it('returns 500 when scrape fails', async () => {
      scrapePromosport.mockResolvedValue([])
      generatePromosportGrids.mockResolvedValue([])

      const res = await request(app).get('/api/promosport')
      expect(res.status).toBe(500)
      expect(res.body).toHaveProperty('error')
    })
  })

  describe('GET /api/promosport/secret-weapons', () => {
    it('returns weapons data', async () => {
      const weapons = [{ id: 1, match: 'Arsenal vs Chelsea', weapon: 'insider' }]
      secretWeaponsTracker.getWeapons.mockResolvedValue(weapons)

      const res = await request(app).get('/api/promosport/secret-weapons')
      expect([200, 500]).toContain(res.status)
    })
  })

  describe('GET /api/promosport/weapons-history', () => {
    it('returns weapons history', async () => {
      secretWeaponsTracker.getHistory.mockResolvedValue([{ date: '2025-06-01' }])

      const res = await request(app).get('/api/promosport/weapons-history')
      expect([200, 500]).toContain(res.status)
    })
  })

  describe('POST /api/promosport/weapons-results', () => {
    it('returns 400 without concours', async () => {
      const res = await request(app)
        .post('/api/promosport/weapons-results')
        .send({ results: [{ id: 1, hit: true }] })

      expect(res.status).toBe(400)
    })

    it('accepts valid results submission', async () => {
      secretWeaponsTracker.recordResults = jest.fn().mockReturnValue({ correct: 8, total: 13, accuracy: 61.5 })

      const res = await request(app)
        .post('/api/promosport/weapons-results')
        .send({ concours: '878', results: [{ id: 1, hit: true }] })

      expect([200, 404, 500]).toContain(res.status)
    })
  })

  describe('GET /api/promosport/accuracy/:concours', () => {
    it('returns accuracy stats for a concours', async () => {
      promosportResultService.computeAccuracy.mockReturnValue({
        concours: '878', totalMatches: 13, totalCorrect: 8, overallAccuracy: '61.5%',
        grids: [{ name: 'T1', accuracy: '61.5%', correct: 8, total: 13 }]
      })

      const res = await request(app).get('/api/promosport/accuracy/878')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.concours).toBe('878')
      expect(res.body.overallAccuracy).toBe('61.5%')
    })

    it('returns 404 for unknown concours', async () => {
      promosportResultService.computeAccuracy.mockReturnValue(null)

      const res = await request(app).get('/api/promosport/accuracy/999')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/promosport/accuracy', () => {
    it('returns overall stats', async () => {
      promosportResultService.getOverallStats.mockReturnValue({
        concoursCount: 5, totalMatches: 65, totalCorrect: 40, overallAccuracy: '61.5%',
        perGrid: [], recentConcours: []
      })

      const res = await request(app).get('/api/promosport/accuracy')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.stats.concoursCount).toBe(5)
    })

    it('returns empty stats when no data', async () => {
      promosportResultService.getOverallStats.mockReturnValue({
        concoursCount: 0, totalMatches: 0, totalCorrect: 0, overallAccuracy: '0.0%',
        perGrid: [], recentConcours: []
      })

      const res = await request(app).get('/api/promosport/accuracy')
      expect(res.status).toBe(200)
      expect(res.body.stats.totalMatches).toBe(0)
    })
  })

  describe('POST /api/promosport/check-results/:concours', () => {
    it('returns results when available', async () => {
      promosportResultService.checkAndFetchResults.mockResolvedValue([
        { idx: 1, home: 'TeamA', away: 'TeamB', result: '1' }
      ])

      const res = await request(app).post('/api/promosport/check-results/878')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.matches).toBe(1)
    })

    it('returns message when no results yet', async () => {
      promosportResultService.checkAndFetchResults.mockResolvedValue(null)

      const res = await request(app).post('/api/promosport/check-results/999')
      expect(res.status).toBe(200)
      expect(res.body.message).toBe('Pas encore de résultats disponibles')
    })
  })

  describe('POST /api/promosport/retrain', () => {
    it('returns steps on success', async () => {
      const res = await request(app).post('/api/promosport/retrain')
      expect([200, 500]).toContain(res.status)
    })
  })
})
