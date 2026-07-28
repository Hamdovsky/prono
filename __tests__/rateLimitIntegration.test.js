/**
 * Rate Limit Integration Tests
 * Tests for global rate-limit middleware on /api routes + localOrAuth guard.
 */

const request = require('supertest')

// Mock heavy deps that break in test env
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

describe('Global rate-limit on /api routes', () => {
  it('should allow requests from localhost', async () => {
    const res = await request(app).get('/api/ping').set('X-Forwarded-For', '127.0.0.1')
    expect(res.status).not.toBe(429)
  })

  it('should rate-limit external IP after 60 requests in 1min', async () => {
    const ip = '203.0.113.99'
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get('/api/ping').set('X-Forwarded-For', ip)
      if (res.status === 429) break
    }
    const res = await request(app).get('/api/ping').set('X-Forwarded-For', ip)
    expect(res.status).toBe(429)
  })

  it('should return 429 with JSON error body', async () => {
    const ip = '198.51.100.50'
    for (let i = 0; i < 60; i++) {
      await request(app).get('/api/ping').set('X-Forwarded-For', ip)
    }
    const res = await request(app).get('/api/ping').set('X-Forwarded-For', ip)
    expect(res.status).toBe(429)
    expect(res.body).toHaveProperty('error')
  })
})

describe('localOrAuth pattern (localhost bypasses auth)', () => {
  const origEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = origEnv
  })

  it('should allow localhost to access protected routes without token', async () => {
    process.env.NODE_ENV = 'production'
    const res = await request(app).get('/api/bot-debug').set('X-Forwarded-For', '127.0.0.1')
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  it('should require valid token for external IP on protected routes', async () => {
    process.env.NODE_ENV = 'production'
    const ip = '203.0.113.77'
    const res = await request(app).get('/api/bot-debug').set('X-Forwarded-For', ip)
    expect(res.status).toBe(401)
  })

  it('should accept valid token from external IP', async () => {
    process.env.NODE_ENV = 'production'
    const ip = '203.0.113.78'
    const res = await request(app)
      .get('/api/bot-debug')
      .set('X-Forwarded-For', ip)
      .set('Authorization', 'Bearer test-secret-key')
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})
