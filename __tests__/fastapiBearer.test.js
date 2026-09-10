const actualFs = jest.requireActual('fs')
const path = require('path')

jest.mock('axios', () => ({
  post: jest.fn(async () => ({ data: { success: true } })),
  get: jest.fn(async () => ({ data: {} })),
}))

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

describe('Node -> FastAPI : Bearer envoyé dès qu’API_SECRET_KEY existe (fail-closed)', () => {
  const saved = process.env.API_SECRET_KEY

  afterEach(() => {
    if (saved === undefined) delete process.env.API_SECRET_KEY
    else process.env.API_SECRET_KEY = saved
    jest.clearAllMocks()
  })

  it('pythonService.predict passe Authorization: Bearer', async () => {
    process.env.API_SECRET_KEY = 'k-test-python'
    jest.resetModules()
    const axios = require('axios')
    const pythonService = require('../core/pythonService')
    await pythonService.predict({ homeTeam: 'A', awayTeam: 'B' })
    const opts = axios.post.mock.calls[0][2]
    expect(opts.headers.Authorization).toBe('Bearer k-test-python')
  })

  it('pythonService.predict sans secret => pas de header', async () => {
    delete process.env.API_SECRET_KEY
    jest.resetModules()
    const axios = require('axios')
    const pythonService = require('../core/pythonService')
    await pythonService.predict({ homeTeam: 'A', awayTeam: 'B' })
    const opts = axios.post.mock.calls[0][2]
    expect(opts.headers.Authorization).toBeUndefined()
  })

  it('fallback_enricher et goalmodel/fit envoient le Bearer (statique)', () => {
    const fe = actualFs.readFileSync(
      path.join(__dirname, '../services/fallback_enricher.js'),
      'utf8'
    )
    expect(fe).toMatch(/Authorization:\s*`Bearer \$\{process\.env\.API_SECRET_KEY\}`/)
    const app = actualFs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
    expect(app).toMatch(/Authorization:\s*`Bearer \$\{process\.env\.API_SECRET_KEY\}`/)
  })
})
