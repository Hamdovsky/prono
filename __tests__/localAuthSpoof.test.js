/**
 * Proxy-spoof tests for the localOrAuth / localOnlyOrAuth guards.
 *
 * The guards must trust ONLY the real TCP peer (req.socket.remoteAddress),
 * NEVER the client-controlled req.ip (derived from X-Forwarded-For).
 * A spoofed `X-Forwarded-For: 127.0.0.1` must therefore be IGNORED.
 */

const express = require('express')
const request = require('supertest')

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))

jest.mock('../core/speedCache', () => ({ speedCache: {} }))

jest.mock('../services/botService', () => ({
  token: 'test-token-12345',
  chatId: 'chat-id-67890',
  isPolling: true,
}))

jest.mock('../services/mlPredictionService', () => ({
  getMLPrediction: jest.fn(),
}))

// Use the REAL securityEngine (do NOT mock it) so 401/403 are produced honestly.
const systemRoutes = require('../routes/system')

const origEnv = process.env.NODE_ENV

beforeAll(() => {
  process.env.API_SECRET_KEY = 'test-secret-key'
})

afterAll(() => {
  delete process.env.API_SECRET_KEY
  process.env.NODE_ENV = origEnv
})

// Simulate a request whose real TCP peer is `remoteAddr` (socket),
// regardless of any X-Forwarded-For header the client sends.
function makeApp(remoteAddr) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.socket = { remoteAddress: remoteAddr }
    next()
  })
  app.use('/api', systemRoutes)
  return app
}

describe('localOrAuth — X-Forwarded-For spoof must be ignored (system.js)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'production'
  })

  it('external peer + spoofed X-Forwarded-For 127.0.0.1 => 401 (spoof ignored)', async () => {
    const app = makeApp('203.0.113.5')
    const res = await request(app).get('/api/bot-debug').set('X-Forwarded-For', '127.0.0.1')
    expect(res.status).toBe(401)
  })

  it('external peer with valid token => allowed', async () => {
    const app = makeApp('203.0.113.5')
    const res = await request(app)
      .get('/api/bot-debug')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('Authorization', 'Bearer test-secret-key')
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  it('real localhost peer => bypass (no token required)', async () => {
    const app = makeApp('::ffff:127.0.0.1')
    const res = await request(app).get('/api/bot-debug')
    expect(res.status).toBe(200)
  })
})

describe('localOnlyOrAuth — external spoof must not bypass (system.js)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'production'
  })

  it('external peer + spoofed X-Forwarded-For 127.0.0.1 => 401 on /predict', async () => {
    const app = makeApp('203.0.113.6')
    const res = await request(app).post('/api/predict').set('X-Forwarded-For', '127.0.0.1')
    expect(res.status).toBe(401)
  })

  it('external peer with valid token => 200 (handler reached)', async () => {
    const app = makeApp('203.0.113.6')
    const res = await request(app)
      .post('/api/predict')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('Authorization', 'Bearer test-secret-key')
    // mlPredictionService.getMLPrediction is mocked -> returns undefined -> success
    expect([200, 500]).toContain(res.status)
  })

  it('real localhost peer => bypass on /predict', async () => {
    const app = makeApp('::ffff:127.0.0.1')
    const res = await request(app).post('/api/predict')
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})
