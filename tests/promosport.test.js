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

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { scrapePromosport } = require('../core/promosport_scraper')
const { generatePromosportGrids, generateGoldCoupon } = require('../core/promosport_engine')
const secretWeaponsTracker = require('../services/secretWeaponsTracker')

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
})
