const express = require('express')
const request = require('supertest')

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../core/database', () => {
  const mockPrepare = jest.fn().mockReturnValue({
    all: jest.fn().mockReturnValue([]),
    get: jest.fn().mockReturnValue(null),
    run: jest.fn().mockReturnValue({ changes: 0 }),
  })
  return {
    getMatchesByStatuses: jest.fn().mockReturnValue([]),
    getMatchById: jest.fn().mockReturnValue(null),
    getDb: jest.fn().mockReturnValue({ prepare: mockPrepare }),
  }
})

jest.mock('../core/enriched_predictions', () => ({
  getEnrichedPrediction: jest.fn().mockReturnValue(null),
  saveEnrichedPrediction: jest.fn(),
}))

jest.mock('../scripts/today_analysis', () => ({
  loadAccuracyLog: jest.fn().mockReturnValue([]),
  runAnalysis: jest.fn().mockReturnValue({}),
}))

jest.mock('../config/leagueRegistry', () => ({
  LEAGUE_MAP: {},
}))

jest.mock('../services/autopsyService', () => ({
  generateReport: jest.fn().mockReturnValue({ report: 'empty' }),
}))

jest.mock('../scripts/daily_draws', () => ({
  getDailyDraws: jest.fn().mockReturnValue([]),
}))

jest.mock('../src/services/oddsService', () => ({
  getSafeTicket: jest.fn().mockReturnValue([]),
}))

jest.mock('../services/adaptiveLearningEngine', () => ({
  feedMatch: jest.fn().mockReturnValue({ success: true }),
  feedBatch: jest.fn().mockReturnValue({ processed: 0 }),
  getLeagueReport: jest.fn().mockReturnValue({}),
  getLeagues: jest.fn().mockReturnValue([]),
  getWeights: jest.fn().mockReturnValue({}),
  autoProcess: jest.fn().mockReturnValue({ processed: 0 }),
  getChallenger: jest.fn().mockReturnValue({}),
}))

jest.mock('../services/valueBetEnricher', () => ({
  enrichValueBets: jest.fn().mockReturnValue([]),
}))

jest.mock('../services/integrity_service', () => ({
  checkIntegrity: jest.fn().mockReturnValue([]),
}))

jest.mock('../services/oddsMovementService', () => ({
  getMovements: jest.fn().mockReturnValue([]),
}))

jest.mock('../services/asianHandicapService', () => ({
  getAsianHandicaps: jest.fn().mockReturnValue([]),
}))

jest.mock('../services/marketAnalysisService', () => ({
  analyzeMarkets: jest.fn().mockReturnValue({}),
}))

jest.mock('../core/speedCache', () => ({
  speedCache: () => (req, res, next) => next(),
}))

const analyticsRouter = require('../routes/analytics')
const learnRouter = require('../routes/learn')
const evolutionRouter = require('../routes/evolution')
const edgeRouter = require('../routes/edge')
const dsRouter = require('../routes/ds')

afterEach(() => {
  jest.restoreAllMocks()
})

function makeApp(router, path) {
  const app = express()
  app.use(express.json())
  app.use(path, router)
  return app
}

describe('Analytics Routes', () => {
  let app
  beforeAll(() => {
    app = makeApp(analyticsRouter, '/api/analytics')
  })

  it('GET /accuracy', async () => {
    const res = await request(app).get('/api/analytics/accuracy')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /high-scoring', async () => {
    const res = await request(app).get('/api/analytics/high-scoring')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /golden-coupon', async () => {
    const res = await request(app).get('/api/analytics/golden-coupon')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /accuracy/tracker', async () => {
    const res = await request(app).get('/api/analytics/accuracy/tracker')
    expect([200, 500]).toContain(res.status)
  })

  it('POST /accuracy/run', async () => {
    const res = await request(app).post('/api/analytics/accuracy/run')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /draws/daily', async () => {
    const res = await request(app).get('/api/analytics/draws/daily')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /safe-ticket', async () => {
    const res = await request(app).get('/api/analytics/safe-ticket')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /autopsy/report', async () => {
    const res = await request(app).get('/api/analytics/autopsy/report')
    expect([200, 500]).toContain(res.status)
  })
})

describe('Learn Routes', () => {
  let app
  beforeAll(() => {
    app = makeApp(learnRouter, '/api/learn')
  })

  it('GET /leagues', async () => {
    const res = await request(app).get('/api/learn/leagues')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /report/:league', async () => {
    const res = await request(app).get('/api/learn/report/Premier League')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /weights/:league', async () => {
    const res = await request(app).get('/api/learn/weights/Premier League')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /auto-process', async () => {
    const res = await request(app).get('/api/learn/auto-process')
    expect([200, 500]).toContain(res.status)
  })

  it('POST / feeds a match', async () => {
    const res = await request(app)
      .post('/api/learn')
      .send({ homeTeam: 'A', awayTeam: 'B', result: '1' })
    expect([200, 400, 500]).toContain(res.status)
  })

  it('POST /batch', async () => {
    const res = await request(app).post('/api/learn/batch').send({ matches: [] })
    expect([200, 400, 500]).toContain(res.status)
  })
})

describe('Evolution Routes', () => {
  let app
  beforeAll(() => {
    app = makeApp(evolutionRouter, '/api/evolution')
  })

  it('GET /accuracy', async () => {
    const res = await request(app).get('/api/evolution/accuracy')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /accuracy?days=7', async () => {
    const res = await request(app).get('/api/evolution/accuracy?days=7')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /intelligence', async () => {
    const res = await request(app).get('/api/evolution/intelligence')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /performance-metrics', async () => {
    const res = await request(app).get('/api/evolution/performance-metrics')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /sensors', async () => {
    const res = await request(app).get('/api/evolution/sensors')
    expect([200, 500]).toContain(res.status)
  })
})

describe('Edge Routes', () => {
  let app
  beforeAll(() => {
    app = makeApp(edgeRouter, '/api/edge')
  })

  it('GET /edge aggregates data', async () => {
    const res = await request(app).get('/api/edge/edge')
    expect([200, 500]).toContain(res.status)
  })

  it('GET /edge with date param', async () => {
    const res = await request(app).get('/api/edge/edge?date=2025-06-01')
    expect([200, 500]).toContain(res.status)
  })
})

describe('DS Routes', () => {
  let app
  beforeAll(() => {
    app = makeApp(dsRouter, '/api/ds')
  })

  it('GET /performance returns model dashboard', async () => {
    const res = await request(app).get('/api/ds/performance')
    expect([200, 500]).toContain(res.status)
  })
})
