/**
 * E40 — scrapeService : une cote SYNTHETIQUE du pont Python (source='default'
 * via ml_monte_carlo) ne doit PAS court-circuiter la chaine avant Jina.
 * Garde ODDS_REJECT_SYNTHETIC (defaut OFF = non-regression stricte).
 */
jest.mock('child_process', () => ({ spawn: jest.fn() }))
jest.mock('https', () => ({ get: jest.fn(), request: jest.fn() }))
jest.mock('../services/scraperProxy', () => ({
  isAvailable: () => false,
  fetchText: jest.fn(),
}))

const { EventEmitter } = require('events')
const cp = require('child_process')
const https = require('https')
const scrapeService = require('../services/scrapeService')

function mockPython(stdoutObj) {
  cp.spawn.mockImplementation(() => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = jest.fn()
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify(stdoutObj))
      proc.emit('close', 0)
    })
    return proc
  })
}

function mockJina(markdown) {
  https.get.mockImplementation((url, opts, cb) => {
    const res = new EventEmitter()
    res.statusCode = 200
    res.headers = {}
    const req = new EventEmitter()
    req.destroy = jest.fn()
    setImmediate(() => {
      cb(res)
      res.emit('data', url.includes('r.jina.ai') ? markdown : '')
      res.emit('end')
    })
    return req
  })
}

const SYNTH = {
  home_win: 2.5,
  draw: 3.2,
  away_win: 2.8,
  over_25: 2.65,
  under_25: 1.61,
  btts_yes: 2.26,
  btts_no: 1.79,
  source: 'default',
}
const JINA_MD = 'Team A vs Team B\n2.10 3.40 3.60\n'

describe('scrapeService.getOdds — garde synthetique (E40)', () => {
  beforeEach(() => {
    scrapeService.clearCache()
    delete process.env.ODDS_REJECT_SYNTHETIC
    cp.spawn.mockReset()
    https.get.mockReset()
  })

  afterEach(() => {
    delete process.env.ODDS_REJECT_SYNTHETIC
  })

  it('OFF (defaut) : le synthetique Python court-circuite, comportement historique', async () => {
    mockPython(SYNTH)
    mockJina(JINA_MD)
    const r = await scrapeService.getOdds('Team A', 'Team B', 'Premier League', 'England')
    expect(r).toBeTruthy()
    expect(r.source).toBe('default')
    expect(https.get).not.toHaveBeenCalled()
  })

  it('ON : le synthetique ne court-circuite pas -> Jina (vraie cote) gagne', async () => {
    process.env.ODDS_REJECT_SYNTHETIC = 'on'
    mockPython(SYNTH)
    mockJina(JINA_MD)
    const r = await scrapeService.getOdds('Team A', 'Team B', 'Premier League', 'England')
    expect(r).toBeTruthy()
    expect(r.source).toBe('jina:reader')
    expect(r.home_win).toBe(2.1)
    expect(https.get).toHaveBeenCalled()
  })

  it('ON : aucune vraie cote sur toute la chaine -> synthetique rendu en dernier recours', async () => {
    process.env.ODDS_REJECT_SYNTHETIC = 'on'
    mockPython(SYNTH)
    mockJina('no odds here\n')
    const r = await scrapeService.getOdds('Team A', 'Team B', 'Premier League', 'England')
    expect(r).toBeTruthy()
    expect(r.source).toBe('default')
  })
})
