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

  // Audit 2026-09-10 : le skip se base sur la vraie socket (req.ip/XFF étant
  // spoofables). Via supertest la socket EST localhost -> bypass par design.
  // Le throttlage externe est validé sur un mini-app à socket factice.
  function makeLimitedApp(remoteAddr) {
    const express = require('express')
    const securityEngine = require('../core/securityEngine')
    const a = express()
    a.set('trust proxy', 1)
    a.use((req, res, next) => {
      req.socket = { remoteAddress: remoteAddr }
      next()
    })
    a.use(securityEngine.middleware.bind(securityEngine))
    a.get('/api/ping', (req, res) => res.json({ ok: true }))
    return a
  }

  it('should rate-limit external socket after 60 requests in 1min', async () => {
    let limitedApp
    jest.isolateModules(() => {
      limitedApp = makeLimitedApp('203.0.113.99')
    })
    for (let i = 0; i < 60; i++) {
      await request(limitedApp).get('/api/ping')
    }
    const res = await request(limitedApp).get('/api/ping')
    expect(res.status).toBe(429)
  })

  it('should return 429 with JSON error body', async () => {
    let limitedApp
    jest.isolateModules(() => {
      limitedApp = makeLimitedApp('198.51.100.50')
    })
    for (let i = 0; i < 60; i++) {
      await request(limitedApp).get('/api/ping')
    }
    const res = await request(limitedApp).get('/api/ping')
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

  it('should ignore spoofed X-Forwarded-For (localhost decision uses real socket only)', async () => {
    process.env.NODE_ENV = 'production'
    // The real socket here is localhost, so it bypasses regardless of a
    // client-supplied external X-Forwarded-For header. The header must NOT
    // influence the localhost/auth decision (req.ip is ignored).
    const ip = '203.0.113.77'
    const res = await request(app).get('/api/bot-debug').set('X-Forwarded-For', ip)
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
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
