/**
 * crawl4aiScraper.test.js — Tests unitaires du client Crawl4AI (offline).
 *
 * Aucun appel réseau : le transport HTTP et la résolution venv sont contournés
 * via les hooks exposés (_resetForTests du resolver) et des mockRequire de
 * SofascoreBypass (resolveEvent).
 */

jest.mock('http', () => ({ request: jest.fn() }))
jest.mock('https', () => ({ request: jest.fn() }))

const http = require('http')
const resolver = require('../core/utils/crawl4aiResolver')

/** Reponse /health simulee : 'ok' | 'down' | 'pass' (pas de reponse). */
let healthMode = 'ok'
const HEALTH_OK = { status: 'ok', browser_alive: true, version: 'test' }

function emitJson(options, cb, payload, statusCode) {
  const res = new (require('events').EventEmitter)()
  res.statusCode = statusCode
  setImmediate(() => {
    cb(res)
    res.emit('data', Buffer.from(JSON.stringify(payload)))
    res.emit('end')
  })
  return res
}

function makeReq(options) {
  const req = new (require('events').EventEmitter)()
  req.write = jest.fn(recordBody(options))
  req.end = jest.fn()
  req.destroy = jest.fn()
  return req
}

/**
 * Repond a /health si le test ne l'a pas desactive : le client sonde
 * systematiquement /health avant /crawl et /md, sinon chaque test devrait
 * empiler une reponse health.
 */
function maybeAnswerHealth(options, cb) {
  // 'pass' : le test fournit lui-meme sa reponse sur /health.
  if (healthMode === 'pass') return false
  if (options.path !== '/health') return false
  if (healthMode === 'down') {
    emitJson(options, cb, { detail: 'service indisponible' }, 503)
  } else {
    emitJson(options, cb, HEALTH_OK, 200)
  }
  return true
}

function loadScraper({ enabled = 'on', url = 'http://127.0.0.1:11235', health = 'ok' } = {}) {
  process.env.CRAWL4AI_ENABLED = enabled
  process.env.CRAWL4AI_URL = url
  delete process.env.CRAWL4AI_API_TOKEN
  delete process.env.CRAWL4AI_LLM_PROVIDER
  delete process.env.CRAWL4AI_HEADFUL
  delete process.env.CRAWL4AI_USER_AGENT
  delete process.env.CRAWL4AI_WAIT_FOR
  healthMode = health
  // Purge ciblee : on garde la meme instance mock de 'http' que celle du test.
  delete require.cache[require.resolve('../services/scrapers/Crawl4aiScraper')]
  delete require.cache[require.resolve('../core/utils/crawl4aiResolver')]
  const scraper = require('../services/scrapers/Crawl4aiScraper')
  // Cache health de la FRAICHE instance du resolver (celle utilisee par le scraper) :
  // isAvailable() est synchrone, on la rend deterministe sans reseau.
  require('../core/utils/crawl4aiResolver')._primeHealthCache(health === 'down' ? false : true, HEALTH_OK)
  scraper.clearCache()
  scraper.resetCircuitBreaker()
  return scraper
}

/**
 * Reponse JSON simulee pour le prochain http.request (une seule fois).
 * @param {object} payload
 * @param {number} statusCode
 */
function mockResponseOnce(payload, statusCode = 200) {
  http.request.mockImplementationOnce((options, cb) => {
    if (maybeAnswerHealth(options, cb)) return makeReq(options)
    emitJson(options, cb, payload, statusCode)
    return makeReq(options)
  })
}

/** Reponse JSON persistante (toutes les requetes). */
function mockResponseAlways(payload, statusCode = 200) {
  http.request.mockImplementation((options, cb) => {
    if (maybeAnswerHealth(options, cb)) return makeReq(options)
    emitJson(options, cb, payload, statusCode)
    return makeReq(options)
  })
}

/** Erreur reseau sur toutes les requetes. */
function mockNetworkError(err = new Error('ECONNREFUSED')) {
  http.request.mockImplementation((options) => {
    const req = makeReq(options)
    if (options.path === '/health' && healthMode !== 'down') {
      req.end = jest.fn(function () {
        setImmediate(() => req.emit('error', err))
      })
      return req
    }
    req.end = jest.fn(function () {
      setImmediate(() => req.emit('error', err))
    })
    return req
  })
}

/** Corps reels envoyes au service : [{ path, body }]. */
let sentBodies = []

function recordBody(options) {
  return function (chunk) {
    try {
      sentBodies.push({ path: options.path, body: JSON.parse(String(chunk)) })
    } catch (_) {}
  }
}

/**
 * Reponses pilotees par endpoint : { '/crawl': payload, '/md': payload, ... }.
 * Les endpoints non listes renvoient `default` (ou un payload vide).
 */
function mockResponseByPath(map, defaultPayload = { success: true, results: [] }) {
  http.request.mockImplementation((options, cb) => {
    if (maybeAnswerHealth(options, cb)) return makeReq(options)
    const path = options.path
    const entry = Object.prototype.hasOwnProperty.call(map, path) ? map[path] : defaultPayload
    const payload = entry.payload !== undefined ? entry.payload : entry
    const statusCode = entry.statusCode || 200
    const res = new (require('events').EventEmitter)()
    res.statusCode = statusCode
    setImmediate(() => {
      cb(res)
      res.emit('data', Buffer.from(JSON.stringify(payload)))
      res.emit('end')
    })
    const req = new (require('events').EventEmitter)()
    req.write = jest.fn(recordBody(options))
    req.end = jest.fn()
    req.destroy = jest.fn()
    return req
  })
}

// resolveEvent est appele par getOdds pour construire l'URL sofascore.
jest.mock('../services/scrapers/SofascoreBypass', () => ({
  resolveEvent: jest.fn(async () => 1234567),
}))

const SofascoreBypass = require('../services/scrapers/SofascoreBypass')

const originalEnv = { ...process.env }

afterEach(() => {
  http.request.mockReset()
  jest.clearAllMocks()
  sentBodies = []
  process.env = { ...originalEnv }
  healthMode = 'ok'
  resolver._resetForTests()
})

describe('crawl4aiResolver', () => {
  test('isCrawl4aiEnabled respecte off/0/false/no', () => {
    resolver._resetForTests()
    for (const v of ['off', '0', 'false', 'no', 'OFF', '']) {
      process.env.CRAWL4AI_ENABLED = v
      expect(resolver.isCrawl4aiEnabled()).toBe(false)
    }
    for (const v of ['on', '1', 'true', 'yes']) {
      process.env.CRAWL4AI_ENABLED = v
      expect(resolver.isCrawl4aiEnabled()).toBe(true)
    }
  })

  test('getCrawl4aiUrl retire le slash final et lit CRAWL4AI_URL', () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_URL = 'http://127.0.0.1:11235/'
    expect(resolver.getCrawl4aiUrl()).toBe('http://127.0.0.1:11235')
    delete process.env.CRAWL4AI_URL
    resolver._resetForTests()
    expect(resolver.getCrawl4aiUrl()).toBe('http://127.0.0.1:11235')
  })

  test('isAvailable renvoie false quand desactive, sans appel reseau', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'off'
    expect(await resolver.isAvailable()).toBe(false)
    expect(http.request).not.toHaveBeenCalled()
  })

  test('getHealth renvoie ok:true sur HTTP 200 et met le cache a jour', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    process.env.CRAWL4AI_URL = 'http://127.0.0.1:11235'
    mockResponseOnce({ status: 'ok', browser_alive: false, version: 'unknown' })
    expect(await resolver.isAvailable()).toBe(true)
    expect(http.request).toHaveBeenCalledTimes(1)
    // 2e appel : cache 30s -> pas de nouvelle requete
    expect(await resolver.isAvailable()).toBe(true)
    expect(http.request).toHaveBeenCalledTimes(1)
  })

  test('isAvailable renvoie false sur erreur reseau (service down)', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    mockNetworkError()
    expect(await resolver.isAvailable({ force: true })).toBe(false)
  })

  test('isAvailable renvoie false sur statut HTTP != 200', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    healthMode = 'pass' // laisse le mock du test repondre sur /health
    mockResponseAlways({ detail: 'unauthorized' }, 401)
    expect(await resolver.isAvailable({ force: true })).toBe(false)
  })

  test('clearHealthCache force une nouvelle sonde', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    mockResponseAlways({ status: 'ok' })
    expect(await resolver.isAvailable()).toBe(true)
    resolver.clearHealthCache()
    expect(await resolver.isAvailable()).toBe(true)
    expect(http.request).toHaveBeenCalledTimes(2)
  })

  test('pickPython prefere le venv isole .venv-crawl4ai', () => {
    const fs = require('fs')
    const realExists = jest.requireActual('fs').existsSync
    const spy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (typeof p === 'string' && p.includes('.venv-crawl4ai')) return true
      return realExists(p)
    })
    resolver._resetForTests()
    const py = resolver.pickPython()
    expect(py).toContain('.venv-crawl4ai')
    expect(py).toMatch(/python(\.exe)?$/)
    spy.mockRestore()
  })

  test('pickPython retombe sur un interpreteur quand aucun venv existe', () => {
    const fs = require('fs')
    const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false)
    resolver._resetForTests()
    expect(resolver.pickPython()).toBe('python3')
    spy.mockRestore()
    resolver._resetForTests()
  })
})

describe('Crawl4aiScraper isAvailable', () => {
  test('false quand CRAWL4AI_ENABLED=off', () => {
    const s = loadScraper({ enabled: 'off' })
    expect(s.isAvailable()).toBe(false)
  })

  test('true quand CRAWL4AI_ENABLED=on et circuit ferme', () => {
    const s = loadScraper({ enabled: 'on' })
    expect(s.isAvailable()).toBe(true)
  })

  test('false quand le circuit breaker est ouvert', () => {
    const s = loadScraper({ enabled: 'on' })
    // 100 echecs consecutifs -> OPEN
    for (let i = 0; i < 100; i++) s._recordFailure()
    expect(s.isAvailable()).toBe(false)
    s.resetCircuitBreaker()
    expect(s.isAvailable()).toBe(true)
  })

  test('isAvailableAsync consulte le health du service', async () => {
    const s = loadScraper({ enabled: 'on' })
    resolver._resetForTests()
    mockResponseOnce({ status: 'ok' })
    expect(await s.isAvailableAsync()).toBe(true)
  })

  test('isAvailable() est false quand le health cache dit service down', () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    expect(s.isAvailable()).toBe(false)
  })

  test('isAvailable() est true quand le health cache dit service up', () => {
    const s = loadScraper({ enabled: 'on', health: 'ok' })
    expect(s.isAvailable()).toBe(true)
  })

  test('isAvailableAsync false quand /health repond 503', async () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    expect(await s.isAvailableAsync()).toBe(false)
  })

  test('refreshHealth rechauffe le cache sans await', async () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    expect(s.isAvailable()).toBe(false)
    healthMode = 'ok'
    mockResponseAlways(HEALTH_OK)
    await s.refreshHealth({ force: true })
    expect(s.isAvailable()).toBe(true)
  })

  test('refreshHealth respecte le cache negatif (pas de re-sondage immediat)', async () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    healthMode = 'ok'
    mockResponseAlways(HEALTH_OK)
    await s.refreshHealth() // cache encore frais -> aucune requete
    expect(s.isAvailable()).toBe(false)
    expect(http.request).not.toHaveBeenCalled()
  })

  test('refreshHealth ne sonde rien quand desactive', async () => {
    const s = loadScraper({ enabled: 'off' })
    await s.refreshHealth()
    expect(http.request).not.toHaveBeenCalled()
  })

  test('getOdds ne tente aucun crawl quand le service est down', async () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    const paths = http.request.mock.calls.map((c) => c[0].path)
    expect(paths.every((p) => p === '/health')).toBe(true)
  })

  test('getResults / getLiveScores / scrapeUrl renvoient vide quand le service est down', async () => {
    const s = loadScraper({ enabled: 'on', health: 'down' })
    expect(await s.getResults('Premier League')).toEqual([])
    expect(await s.getLiveScores('Premier League')).toEqual([])
    expect(await s.scrapeUrl('https://www.sofascore.com/')).toBeNull()
  })
})

describe('crawl4aiResolver getCachedHealth', () => {
  test('probed=false tant qu aucune sonde n a eu lieu', () => {
    resolver._resetForTests()
    const c = resolver.getCachedHealth()
    expect(c.probed).toBe(false)
    expect(c.stale).toBe(true)
    expect(c.ageMs).toBe(Infinity)
  })

  test('probed=true et stale=false juste apres une sonde ok', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    mockResponseOnce(HEALTH_OK)
    await resolver.isAvailable()
    const c = resolver.getCachedHealth()
    expect(c.probed).toBe(true)
    expect(c.ok).toBe(true)
    expect(c.stale).toBe(false)
    expect(c.ageMs).toBeLessThan(1000)
  })

  test('ok=false apres une sonde en echec', async () => {
    resolver._resetForTests()
    process.env.CRAWL4AI_ENABLED = 'on'
    mockNetworkError()
    expect(await resolver.isAvailable({ force: true })).toBe(false)
    expect(resolver.getCachedHealth().ok).toBe(false)
  })
})

describe('Crawl4aiScraper getOdds', () => {
  test('retourne null sans appeler le service quand desactive', async () => {
    const s = loadScraper({ enabled: 'off' })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    expect(http.request).not.toHaveBeenCalled()
  })

  test('retourne null et ne leve pas quand resolveEvent echoue', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValueOnce(null)
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    expect(http.request).not.toHaveBeenCalled()
  })

  test('extrait les cotes via /crawl JsonCss (raw_text) et tagge crawl4ai', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({
      success: true,
      results: [{ extracted: { raw_text: '1 : 2.10   X : 3.40   2 : 3.80' } }],
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).not.toBeNull()
    expect(out.home_win).toBeCloseTo(2.1)
    expect(out.draw).toBeCloseTo(3.4)
    expect(out.away_win).toBeCloseTo(3.8)
    expect(out._scraper).toBe('crawl4ai')
    expect(out.source).toBe('sofascore:crawl4ai')
    expect(out.match_url).toContain('https://www.sofascore.com/event/999/odds')
  })

  test('fallback /md quand le schema CSS ne remonte aucun marche', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    // 1er appel /crawl : extracted vide
    mockResponseOnce({ success: true, results: [{ extracted: { raw_text: 'no odds here' } }] })
    // 2e appel /md : markdown avec cotes
    mockResponseOnce({
      success: true,
      markdown: 'Arsenal vs Liverpool\n2.10  3.40  3.80\nOver: 1.90 1.95',
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).not.toBeNull()
    expect(out.home_win).toBeCloseTo(2.1)
    expect(out.over_25).toBeCloseTo(1.9)
    expect(out._scraper).toBe('crawl4ai')
  })

  test('retourne null et n leve pas quand le service est down (2 URLs x 2 tentatives)', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockNetworkError()
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
  })

  test('retourne null quand le service repond 500', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({ detail: 'boom' }, 500)
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
  })

  test('cache 10 min : le 2e appel identique ne re-sollicite pas le service', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({
      success: true,
      results: [{ extracted: { raw_text: '1 : 2.10  X : 3.40  2 : 3.80' } }],
    })
    const a = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    const callsAfterFirst = http.request.mock.calls.length
    const b = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(http.request.mock.calls.length).toBe(callsAfterFirst)
    expect(b).toEqual(a)
    expect(s.getCacheSize()).toBe(1)
  })

  test('la cle de cache ignore casse/accents/ordre de casse', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({
      success: true,
      results: [{ extracted: { raw_text: '1 : 2.10  X : 3.40  2 : 3.80' } }],
    })
    await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    await s.getOdds('  arsenal ', 'LIVERPOOL', 'premier league')
    expect(s.getCacheSize()).toBe(1)
  })

  test('n utilise pas le fallback LLM quand CRAWL4AI_LLM_PROVIDER est vide', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    // /crawl vide + /md vide sur les 2 URLs, puis pas de llm
    mockResponseAlways({ success: true, results: [{ extracted: { raw_text: '' } }] })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    const endpoints = http.request.mock.calls.map((c) => c[0].path)
    expect(endpoints.every((p) => p !== '/llm-extract')).toBe(true)
  })

  test('fallback LLM quand CRAWL4AI_LLM_PROVIDER + OPENROUTER_API_KEY sont poses', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    process.env.CRAWL4AI_LLM_PROVIDER = 'openrouter/openai/gpt-4o-mini'
    process.env.OPENROUTER_API_KEY = 'sk-test'
    mockResponseByPath({
      '/crawl': { success: true, results: [{ extracted: { raw_text: '' } }] },
      '/md': { success: true, markdown: 'no odds on this page' },
      '/llm-extract': {
        success: true,
        result: {
          matches: [
            { home_team: 'Arsenal', away_team: 'Liverpool', home_win: 2.05, draw: 3.5, away_win: 3.9 },
          ],
        },
      },
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).not.toBeNull()
    expect(out.home_win).toBeCloseTo(2.05)
    expect(out.source).toBe('sofascore:crawl4ai:llm')
    const paths = http.request.mock.calls.map((c) => c[0].path)
    expect(paths).toContain('/llm-extract')
  })
})

describe('Crawl4aiScraper helpers', () => {
  test('extractOddsFromMarkdown detecte 1X2 + O/U + BTTS', () => {
    const s = loadScraper()
    const md = 'Arsenal vs Liverpool\n2.10  3.40  3.80\nOver: 1.90 1.95\nBTTS: 1.75 2.05'
    const r = s._extractOddsFromMarkdown(md, 'Arsenal', 'Liverpool')
    expect(r).toHaveLength(1)
    expect(r[0].home_win).toBeCloseTo(2.1)
    expect(r[0].under_25).toBeCloseTo(1.95)
    expect(r[0].btts_yes).toBeCloseTo(1.75)
  })

  test('extractOddsFromMarkdown filtre par indices d equipes', () => {
    const s = loadScraper()
    const md = 'Arsenal vs Liverpool\n2.10  3.40  3.80\nChelsea vs City\n1.50  4.20  6.00'
    const r = s._extractOddsFromMarkdown(md, 'Chelsea', 'City')
    expect(r).toHaveLength(1)
    expect(r[0].home_team).toBe('Chelsea')
  })

  test('extractOddsDirect lit un bloc 1X2 colle', () => {
    const s = loadScraper()
    const d = s._extractOddsDirect('1: 2.10 X: 3.40 2: 3.80 Over 2.5: 1.90 Under 2.5: 1.95')
    expect(d.home_win).toBeCloseTo(2.1)
    expect(d.draw).toBeCloseTo(3.4)
    expect(d.away_win).toBeCloseTo(3.8)
    expect(d.over_25).toBeCloseTo(1.9)
  })

  test('extractOddsDirect renvoie null sur texte vide', () => {
    const s = loadScraper()
    expect(s._extractOddsDirect('nothing here')).toBeNull()
    expect(s._extractOddsDirect('')).toBeNull()
  })

  test('hasAnyMarket exige au moins un marche', () => {
    const s = loadScraper()
    expect(s._hasAnyMarket({ home_win: 2, away_win: 3 })).toBe(true)
    expect(s._hasAnyMarket({ over_25: 1.9 })).toBe(true)
    expect(s._hasAnyMarket({})).toBe(false)
    expect(s._hasAnyMarket(null)).toBe(false)
  })

  test('les 3 schemas CSS sont exposes et distincts', () => {
    const s = loadScraper()
    expect(s._SOFASCORE_ODDS_CSS).toBeTruthy()
    expect(s._SOFASCORE_EVENT_CSS).toBeTruthy()
    expect(s._SOFASCORE_STATS_CSS).toBeTruthy()
    expect(s._ODDS_SCHEMA.required).toContain('matches')
  })

  test('envoie le header Authorization quand CRAWL4AI_API_TOKEN est pose', async () => {
    const s = loadScraper({ enabled: 'on' })
    process.env.CRAWL4AI_API_TOKEN = 'secret-token'
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({ success: true, results: [{ extracted: { raw_text: '1: 2.1 X: 3.4 2: 3.8' } }] })
    await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    const first = http.request.mock.calls[0][0]
    expect(first.headers.Authorization).toBe('Bearer secret-token')
  })
})

describe('Crawl4aiScraper anti-bot WAF', () => {
  test('detecte la page de challenge Sofascore', () => {
    const s = loadScraper()
    expect(s._isChallengePage('Verifying you are human…\n')).toBe(true)
    expect(s._isChallengePage('Just a moment...')).toBe(true)
    expect(s._isChallengePage('Checking your browser before accessing')).toBe(true)
  })

  test('ne confond pas une vraie page cotes avec le challenge', () => {
    const s = loadScraper()
    expect(s._isChallengePage('Arsenal vs Liverpool\n2.10 3.40 3.80')).toBe(false)
    expect(s._isChallengePage('')).toBe(false)
    expect(s._isChallengePage(null)).toBe(false)
  })

  test('getOdds court-circuite sur challenge : 1 seule URL tentee, retour null', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseAlways({ success: true, markdown: 'Verifying you are human…' })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    const paths = http.request.mock.calls.map((c) => c[0].path)
    // ni /llm-extract ni de second tour de table sur l'URL de secours
    expect(paths).not.toContain('/llm-extract')
    expect(paths.length).toBeLessThanOrEqual(2)
  })

  test('le /crawl signale aussi le challenge', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseByPath({
      '/crawl': {
        success: true,
        results: [{ status_code: 302, extracted: null, extracted_raw: 'Verifying you are human…' }],
      },
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
  })

  test('le booleen challenge du service suffit (pas de recherche de chaine)', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseByPath({
      '/crawl': { success: true, results: [{ success: true, status_code: 200, challenge: true }] },
      '/md': { success: true, challenge: true, markdown: 'page incomprehensible' },
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).toBeNull()
    const paths = http.request.mock.calls.map((c) => c[0].path)
    expect(paths).not.toContain('/llm-extract')
  })

  test('une page normale (challenge=false) n est pas coupee', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseByPath({
      '/crawl': {
        success: true,
        results: [{ success: true, challenge: false, extracted: { raw_text: '1: 2.1 X: 3.4 2: 3.8' } }],
      },
    })
    const out = await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    expect(out).not.toBeNull()
    expect(out.home_win).toBeCloseTo(2.1)
  })
})

describe('Crawl4aiScraper browser_config headful', () => {
  test('vide par defaut (le service garde son mode headless)', () => {
    const s = loadScraper()
    delete process.env.CRAWL4AI_HEADFUL
    expect(s._buildBrowserConfig()).toEqual({})
  })

  test('CRAWL4AI_HEADFUL demande headless:false', () => {
    const s = loadScraper()
    process.env.CRAWL4AI_HEADFUL = '1'
    expect(s._buildBrowserConfig()).toEqual({ headless: false })
    delete process.env.CRAWL4AI_HEADFUL
  })

  test('/md et /crawl transportent browser_config', async () => {
    const s = loadScraper({ enabled: 'on' })
    process.env.CRAWL4AI_HEADFUL = 'on'
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseByPath({
      '/crawl': { success: true, results: [{ challenge: false, extracted: { raw_text: '1: 2.1 X: 3.4 2: 3.8' } }] },
    })
    await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    const crawl = sentBodies.find((b) => b.path === '/crawl')
    expect(crawl.body.browser_config).toEqual({ headless: false })
    delete process.env.CRAWL4AI_HEADFUL
  })
})

describe('Crawl4aiScraper crawler_config', () => {
  test('buildCrawlerConfig pose UA + locale + wait_until', () => {
    const s = loadScraper()
    const cfg = s._buildCrawlerConfig()
    expect(cfg.user_agent).toContain('Chrome/131')
    expect(cfg.locale).toBe('en-US')
    expect(cfg.wait_until).toBe('domcontentloaded')
  })

  test('buildCrawlerConfig accepte un wait_for supplementaire', () => {
    const s = loadScraper()
    const cfg = s._buildCrawlerConfig({ wait_for: 'div.odds', page_timeout: 45000 })
    expect(cfg.wait_for).toBe('div.odds')
    expect(cfg.page_timeout).toBe(45000)
  })

  test('CRAWL4AI_USER_AGENT personnalisable', () => {
    const s = loadScraper()
    expect(s._resolveUserAgent()).toContain('Chrome/131')
    process.env.CRAWL4AI_USER_AGENT = 'Mozilla/5.0 Custom'
    expect(s._resolveUserAgent()).toBe('Mozilla/5.0 Custom')
    expect(s._buildCrawlerConfig().user_agent).toBe('Mozilla/5.0 Custom')
    delete process.env.CRAWL4AI_USER_AGENT
    expect(s._resolveUserAgent()).toBe(s._DEFAULT_SOFASCORE_UA)
  })

  test('CRAWL4AI_WAIT_FOR personnalisable', () => {
    const s = loadScraper()
    expect(s._resolveWaitFor()).toContain('odds')
    process.env.CRAWL4AI_WAIT_FOR = 'div[data-testid="odds"]'
    expect(s._resolveWaitFor()).toBe('div[data-testid="odds"]')
    delete process.env.CRAWL4AI_WAIT_FOR
  })

  test('les requetes /md et /crawl transportent le crawler_config', async () => {
    const s = loadScraper({ enabled: 'on' })
    SofascoreBypass.resolveEvent.mockResolvedValue(999)
    mockResponseByPath({
      '/crawl': { success: true, results: [{ extracted: { raw_text: '' } }] },
      '/md': { success: true, markdown: 'Verifying you are human…' },
    })
    await s.getOdds('Arsenal', 'Liverpool', 'Premier League')
    const crawl = sentBodies.find((b) => b.path === '/crawl')
    expect(crawl).toBeTruthy()
    expect(crawl.body.crawler_config.user_agent).toContain('Chrome/131')
    expect(crawl.body.crawler_config.locale).toBe('en-US')
    expect(crawl.body.crawler_config.wait_for).toBeTruthy()
    expect(crawl.body.extraction_strategy.schema).toBeTruthy()
    const md = sentBodies.find((b) => b.path === '/md')
    expect(md).toBeTruthy()
    expect(md.body.crawler_config.user_agent).toContain('Chrome/131')
  })
})

describe('Crawl4aiScraper generique', () => {
  test('scrapeUrl renvoie le markdown du service', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockResponseOnce({ success: true, markdown: '# hello' })
    const out = await s.scrapeUrl('https://www.sofascore.com/')
    expect(out).toMatchObject({ markdown: '# hello', source: 'crawl4ai:md' })
  })

  test('scrapeUrl renvoie null quand desactive', async () => {
    const s = loadScraper({ enabled: 'off' })
    expect(await s.scrapeUrl('https://www.sofascore.com/')).toBeNull()
  })

  test('getResults renvoie un tableau vide quand desactive', async () => {
    const s = loadScraper({ enabled: 'off' })
    expect(await s.getResults('Premier League')).toEqual([])
  })

  test('getLiveScores renvoie un tableau vide quand desactive', async () => {
    const s = loadScraper({ enabled: 'off' })
    expect(await s.getLiveScores('Premier League')).toEqual([])
  })

  test('getResults parse les scores du markdown', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockResponseOnce({ success: true, markdown: 'Arsenal 2 - 1 Liverpool' })
    const res = await s.getResults('Premier League')
    expect(Array.isArray(res)).toBe(true)
  })

  test('getLiveScores tolere une erreur reseau', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockNetworkError()
    expect(await s.getLiveScores('Premier League')).toEqual([])
  })

  test('scrapeUrl renvoie null sur page de challenge (pas de faux contenu)', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockResponseOnce({ success: true, markdown: 'Verifying you are human…' })
    expect(await s.scrapeUrl('https://www.sofascore.com/')).toBeNull()
  })

  test('getResults renvoie vide sur page de challenge', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockResponseOnce({ success: true, markdown: 'Just a moment...\nChecking your browser' })
    expect(await s.getResults('Premier League')).toEqual([])
  })

  test('getLiveScores renvoie vide sur page de challenge', async () => {
    const s = loadScraper({ enabled: 'on' })
    mockResponseOnce({ success: true, markdown: 'Verifying you are human…' })
    expect(await s.getLiveScores('Premier League')).toEqual([])
  })
})
