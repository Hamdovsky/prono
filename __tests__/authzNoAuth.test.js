/**
 * Authorization tests — verify sensitive endpoints return 401/403
 * when called WITHOUT a valid Bearer token.
 *
 * Covers the security audit scope:
 *  - routes/promosport.js  POST /retrain, GET /diagnostic
 *  - routes/system.js      POST /sync-matches
 *  - app.js                GET/POST /api/cron/auto-enrich, GET/POST /api/cron/settle
 */

const request = require('supertest')

// Mock heavy deps that break in test env (mirrors rateLimitIntegration.test.js)
jest.mock('../core/pythonService', () => ({ predict: jest.fn() }))
jest.mock('../services/playerPropsService', () => ({
  buildPlayerProps: jest.fn().mockResolvedValue(null),
}))

let app

beforeAll(() => {
  process.env.API_SECRET_KEY = 'test-secret-key'
  app = require('../app')
})

afterAll(() => {
  delete process.env.API_SECRET_KEY
})

describe('Sensitive endpoints reject unauthenticated calls', () => {
  const endpoints = [
    { method: 'post', path: '/api/promosport/retrain', desc: 'POST /api/promosport/retrain' },
    { method: 'get', path: '/api/promosport/diagnostic', desc: 'GET /api/promosport/diagnostic' },
    { method: 'post', path: '/api/sync-matches', desc: 'POST /api/sync-matches' },
    { method: 'get', path: '/api/cron/auto-enrich', desc: 'GET /api/cron/auto-enrich' },
    { method: 'post', path: '/api/cron/auto-enrich', desc: 'POST /api/cron/auto-enrich' },
    { method: 'get', path: '/api/cron/settle', desc: 'GET /api/cron/settle' },
    { method: 'post', path: '/api/cron/settle', desc: 'POST /api/cron/settle' },
  ]

  endpoints.forEach(({ method, path, desc }) => {
    it(`${desc} returns 401 without token`, async () => {
      const res = await request(app)[method](path)
      expect([401, 403]).toContain(res.status)
    })

    it(`${desc} returns 403 with an invalid token`, async () => {
      const res = await request(app)[method](path).set('Authorization', 'Bearer wrong-secret')
      expect([401, 403]).toContain(res.status)
    })
  })

  it('POST /api/sync-matches returns 401 even with a valid body but no token', async () => {
    const res = await request(app)
      .post('/api/sync-matches')
      .send({ matches: [{ id: 'x', homeTeam: 'A', awayTeam: 'B' }] })
    expect([401, 403]).toContain(res.status)
  })
})
