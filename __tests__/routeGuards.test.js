/**
 * Gardes de routes ajoutées par l'audit sécurité 2026-09-10 :
 * bets (bankroll), training/retrain, triggers scraper, et le skip
 * rate-limiter qui ne doit plus se fier à req.ip (spoofable via XFF).
 */
const express = require('express')
const request = require('supertest')
const actualFs = jest.requireActual('fs')
const path = require('path')

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../services/authService', () => ({
  verifyToken: jest.fn((t) => (t === 'jwt-valid' ? { sub: 1 } : null)),
}))

const origEnv = process.env.NODE_ENV

beforeAll(() => {
  process.env.API_SECRET_KEY = 'test-secret-key'
  process.env.NODE_ENV = 'production'
})

afterAll(() => {
  delete process.env.API_SECRET_KEY
  process.env.NODE_ENV = origEnv
})

function makeApp(remoteAddr, routes, mount = '/api') {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.socket = { remoteAddress: remoteAddr }
    next()
  })
  app.use(mount, routes)
  return app
}

describe('routes/bets — protégées hors localhost', () => {
  it('GET /api/bets externe sans token => 401', async () => {
    const betsRoutes = require('../routes/bets')
    const app = makeApp('203.0.113.7', betsRoutes)
    const res = await request(app).get('/api/bets')
    expect(res.status).toBe(401)
  })

  it('POST /api/bets externe avec bon token => pas 401', async () => {
    const betsRoutes = require('../routes/bets')
    const app = makeApp('203.0.113.7', betsRoutes)
    const res = await request(app)
      .post('/api/bets')
      .set('Authorization', 'Bearer test-secret-key')
      .send({})
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })

  it('É9: GET /api/bets externe avec JWT utilisateur valide => pas 401', async () => {
    const betsRoutes = require('../routes/bets')
    const app = makeApp('203.0.113.8', betsRoutes)
    const res = await request(app)
      .get('/api/bets')
      .set('Authorization', 'Bearer jwt-valid')
    expect(res.status).not.toBe(401)
  })

  it('É9: GET /api/bets externe avec JWT invalide => 401', async () => {
    const betsRoutes = require('../routes/bets')
    const app = makeApp('203.0.113.9', betsRoutes)
    const res = await request(app)
      .get('/api/bets')
      .set('Authorization', 'Bearer not-a-jwt')
    expect(res.status).toBe(401)
  })
})

describe('gardes statiques — training & scraper', () => {
  it('POST /retrain/:type est derrière securityEngine.authenticate', () => {
    const src = actualFs.readFileSync(path.join(__dirname, '../routes/training.js'), 'utf8')
    expect(src).toMatch(/\/retrain\/:type['"],\s*\n?\s*require\('\.\.\/core\/securityEngine'\)/)
  })

  it('scan-today, http-scan et bibeet/scrape sont derrière localOrAuth', () => {
    const src = actualFs.readFileSync(path.join(__dirname, '../routes/scraper.js'), 'utf8')
    expect(src).toMatch(/post\('\/scan-today',\s*localOrAuth/)
    expect(src).toMatch(/post\('\/http-scan',\s*localOrAuth/)
    expect(src).toMatch(/post\('\/bibeet\/scrape',\s*localOrAuth/)
  })

  it('plus aucune exposition de keyPrefix dans app.js', () => {
    const src = actualFs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
    expect(src).not.toMatch(/keyPrefix\s*:/)
  })

  it("É9: /api-docs (Swagger) derrière localOrAuth", () => {
    const src = actualFs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
    expect(src).toMatch(/'\/api-docs',[\s\S]{0,160}authGuards'\)\.localOrAuth/)
  })
})

describe('authGuards.localOrAuth — bypass = flag explicite, plus NODE_ENV (É7)', () => {
  let systemRoutes

  beforeAll(() => {
    systemRoutes = require('../routes/system')
  })

  it('socket externe + NODE_ENV=development SANS flag => 401 (ancien trou)', async () => {
    const savedEnv = process.env.NODE_ENV
    delete process.env.AUTH_DEV_BYPASS
    process.env.NODE_ENV = 'development'
    try {
      const app = makeApp('203.0.113.50', systemRoutes)
      const res = await request(app).get('/api/bot-debug')
      expect(res.status).toBe(401)
    } finally {
      process.env.NODE_ENV = savedEnv
    }
  })

  it('socket externe + AUTH_DEV_BYPASS=1 => bypass assumé (local dev)', async () => {
    process.env.AUTH_DEV_BYPASS = '1'
    try {
      const app = makeApp('203.0.113.51', systemRoutes)
      const res = await request(app).get('/api/bot-debug')
      expect(res.status).not.toBe(401)
      expect(res.status).not.toBe(403)
    } finally {
      delete process.env.AUTH_DEV_BYPASS
    }
  })
})

describe('rate limiter — le skip ne fait plus confiance à req.ip (XFF spoofable)', () => {
  it('externe spoofant X-Forwarded-For: 127.0.0.1 finit throttlé (429)', async () => {
    jest.resetModules()
    const securityEngine = require('../core/securityEngine')
    const app = express()
    app.set('trust proxy', 1)
    app.use((req, res, next) => {
      req.socket = { remoteAddress: '203.0.113.8' }
      next()
    })
    app.use(securityEngine.middleware.bind(securityEngine))
    app.get('/probe', (req, res) => res.json({ ok: true }))
    let last
    for (let i = 0; i < 61; i++) {
      last = await request(app).get('/probe').set('X-Forwarded-For', '127.0.0.1')
    }
    expect(last.status).toBe(429)
  })
})
