/**
 * Contrat de la route POST /api/predict (audit 2026-09-10, É14).
 * En prod, le handler VIVANT est celui de app.js (enrichMatch, monté ligne 546)
 // celui de routes/system.js (mlPredictionService, monté via /api ligne 668)
 * est shadowé — les deux sont gardés mais ce test VERROUILLE la precedence :
 * si un refactor réordonne les mounts et réactive la route morte (contrat
 * différent), le test casse au lieu que le bot/tactical_service casse en prod.
 */
const request = require('supertest')

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/pythonService', () => ({ predict: jest.fn() }))
jest.mock('../services/playerPropsService', () => ({
  buildPlayerProps: jest.fn().mockResolvedValue(null),
}))

// Les DEUX moteurs possibles sont mockés avec des signatures distinctes.
jest.mock('../services/enriched_predictions', () => ({
  enrichMatch: jest.fn(async (m) => ({
    handler: 'APP_JS_ENRICHMATCH',
    ai_source: 'TITANIUM_ELITE_V3',
    degraded: false,
    home_win_probability: 55,
    homeTeam: m.homeTeam,
  })),
}))
jest.mock('../services/mlPredictionService', () => ({
  getMLPrediction: jest.fn(async () => ({
    handler: 'SYSTEM_JS_MLPREDICTION',
    success: true,
  })),
}))

const app = require('../app')
const enriched = require('../services/enriched_predictions')

const SECRET = 'contract-test-secret'
const orig = {}

beforeAll(() => {
  orig.API_SECRET_KEY = process.env.API_SECRET_KEY
  orig.DEV_BYPASS = process.env.AUTH_DEV_BYPASS
  process.env.API_SECRET_KEY = SECRET
  delete process.env.AUTH_DEV_BYPASS
})
afterAll(() => {
  if (orig.API_SECRET_KEY === undefined) delete process.env.API_SECRET_KEY
  else process.env.API_SECRET_KEY = orig.API_SECRET_KEY
  if (orig.DEV_BYPASS !== undefined) process.env.AUTH_DEV_BYPASS = orig.DEV_BYPASS
})

const VALID = { homeTeam: 'Tunisia', awayTeam: 'Algeria', league: 'Friendlies' }

describe('POST /api/predict — contrat prod (handler app.js, gardé)', () => {
  it('trafic via proxy Render (XFF externe) sans token => 401', async () => {
    const res = await request(app)
      .post('/api/predict')
      .set('X-Forwarded-For', '203.0.113.60')
      .send(VALID)
    expect(res.status).toBe(401)
  })

  it('XFF externe + mauvais token => 403', async () => {
    const res = await request(app)
      .post('/api/predict')
      .set('X-Forwarded-For', '203.0.113.61')
      .set('Authorization', 'Bearer nope')
      .send(VALID)
    expect(res.status).toBe(403)
  })

  it('interne sans XFF => passe (contractuel, bot/tactical_service 127.0.0.1)', async () => {
    const res = await request(app).post('/api/predict').send(VALID)
    expect(res.status).toBe(200)
  })

  it('token valide + body sans équipes => 400 (validation É11)', async () => {
    const res = await request(app)
      .post('/api/predict')
      .set('X-Forwarded-For', '203.0.113.62')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ foo: 'bar' })
    expect(res.status).toBe(400)
  })

  it('la réponse vient du handler app.js/enrichMatch, PAS de la route shadowée', async () => {
    const res = await request(app)
      .post('/api/predict')
      .set('X-Forwarded-For', '203.0.113.63')
      .set('Authorization', `Bearer ${SECRET}`)
      .send(VALID)
    expect(res.status).toBe(200)
    expect(res.body.handler).toBe('APP_JS_ENRICHMATCH')
    expect(enriched.enrichMatch).toHaveBeenCalled()
  })
})
