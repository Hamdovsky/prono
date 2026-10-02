/**
 * scraperRouterCrawl4ai.test.js — Chaîne prioritaire du routeur avec Crawl4AI.
 *
 * Vérifie l'insertion de crawl4ai entre bypass et firecrawl, l'exclusion quand
 * le flag est off, et l'exposition dans getStatus(). Aucun appel réseau : les
 * scrapers sont mockés via jest.mock.
 */

jest.mock('../services/scrapers/Crawl4aiScraper', () => ({
  getOdds: jest.fn(async () => null),
  getLiveScores: jest.fn(async () => []),
  getResults: jest.fn(async () => []),
  scrapeUrl: jest.fn(async () => null),
  isAvailable: jest.fn(() => true),
  isAvailableAsync: jest.fn(async () => true),
  refreshHealth: jest.fn(async () => true),
  getCacheSize: jest.fn(() => 0),
  clearCache: jest.fn(),
  resetCircuitBreaker: jest.fn(),
}))

jest.mock('../services/scrapers/ScrapingBypassScraper', () => ({
  getOdds: jest.fn(async () => null),
  isAvailable: jest.fn(() => true),
  getCacheSize: jest.fn(() => 0),
  clearCache: jest.fn(),
}))

jest.mock('../services/scrapers/FirecrawlScraper', () => ({
  getOdds: jest.fn(async () => null),
  isAvailable: jest.fn(() => true),
  getCacheSize: jest.fn(() => 0),
  clearCache: jest.fn(),
}))

jest.mock('../services/scrapers/JinaScraper', () => ({
  getOdds: jest.fn(async () => null),
  getResults: jest.fn(async () => []),
  isAvailable: jest.fn(() => true),
  getCacheSize: jest.fn(() => 0),
  clearCache: jest.fn(),
}))

jest.mock('../services/scrapeService', () => ({
  getOdds: jest.fn(async () => null),
  getLiveScores: jest.fn(async () => []),
  getCacheSize: jest.fn(() => 0),
  clearCache: jest.fn(),
}))

jest.mock('../services/scrapers/freeProxyPool', () => ({
  isEnabled: jest.fn(() => false),
  isDegraded: jest.fn(() => false),
  getProxy: jest.fn(() => null),
  getProxyUrl: jest.fn(() => null),
  getStatus: jest.fn(() => ({})),
}))

const router = require('../services/scrapers/index.js')
const crawl4ai = require('../services/scrapers/Crawl4aiScraper')

function setCrawl4aiAvailable(available) {
  crawl4ai.isAvailable.mockReturnValue(available)
}

beforeEach(() => {
  router.resetHealth()
  crawl4ai.isAvailable.mockReturnValue(true)
  crawl4ai.isAvailableAsync.mockResolvedValue(true)
  crawl4ai.refreshHealth.mockResolvedValue(true)
  crawl4ai.getOdds.mockResolvedValue(null)
  crawl4ai.getResults.mockResolvedValue([])
  crawl4ai.getLiveScores.mockResolvedValue([])
  delete process.env.FIRECRAWL_API_KEY
})

describe('chaîne prioritaire avec crawl4ai', () => {
  test('crawl4ai absent de la chaîne quand le service est indisponible', () => {
    setCrawl4aiAvailable(false)
    const chain = router.getStatus().chain
    expect(chain).not.toContain('crawl4ai')
    expect(chain).toEqual(expect.arrayContaining(['bypass', 'jina']))
  })

  test('crawl4ai entre bypass et firecrawl quand disponible', () => {
    setCrawl4aiAvailable(true)
    const chain = router.getStatus().chain
    const iBypass = chain.indexOf('bypass')
    const iC4a = chain.indexOf('crawl4ai')
    const iFirecrawl = chain.indexOf('firecrawl')
    const iJina = chain.indexOf('jina')
    expect(iC4a).toBeGreaterThan(-1)
    expect(iBypass).toBeLessThan(iC4a)
    expect(iC4a).toBeLessThan(iFirecrawl)
    expect(iC4a).toBeLessThan(iJina)
  })

  test('ordre exact : bypass, crawl4ai, firecrawl, jina, python', () => {
    setCrawl4aiAvailable(true)
    const chain = router.getStatus().chain
    const expected = ['bypass', 'crawl4ai', 'firecrawl', 'jina', 'python']
    expect(chain).toEqual(expected.filter((n) => chain.includes(n)))
  })

  test('getStatus rechauffe le cache health sans bloquer (void refreshHealth)', () => {
    setCrawl4aiAvailable(true)
    crawl4ai.refreshHealth.mockClear()
    router.getStatus()
    expect(crawl4ai.refreshHealth).toHaveBeenCalled()
  })

  test('refreshHealth neleve aucune exception quand le service est tombe', async () => {
    setCrawl4aiAvailable(true)
    crawl4ai.refreshHealth.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(() => router.getStatus()).not.toThrow()
  })
})

describe('health tracking crawl4ai', () => {
  test('crawl4ai est present dans health', () => {
    const h = router.getStatus().health
    expect(h).toHaveProperty('crawl4ai')
    expect(h.crawl4ai).toHaveProperty('disabled')
    expect(h.crawl4ai).toHaveProperty('failures')
  })

  test('isHealthy("crawl4ai") respecte le cooldown', () => {
    expect(router.isHealthy('crawl4ai')).toBe(true)
    router.resetHealth()
    expect(router.isHealthy('crawl4ai')).toBe(true)
  })
})

describe('getStatus expose crawl4ai', () => {
  test('getStatus retourne le bloc crawl4ai avec url + enabled', () => {
    setCrawl4aiAvailable(true)
    process.env.CRAWL4AI_URL = 'http://127.0.0.1:11235'
    const st = router.getStatus()
    expect(st.crawl4ai).toBeTruthy()
    expect(st.crawl4ai.url).toBe('http://127.0.0.1:11235')
    expect(typeof st.crawl4ai.available).toBe('boolean')
    expect(st.crawl4ai.health).toBeTruthy()
    delete process.env.CRAWL4AI_URL
  })

  test('cache_size inclut crawl4ai', () => {
    const st = router.getStatus()
    expect(st.cache_size).toHaveProperty('crawl4ai')
  })

  test('getStatus expose health_probed et health_age_ms', () => {
    setCrawl4aiAvailable(true)
    const st = router.getStatus()
    expect(st.crawl4ai).toHaveProperty('health_probed')
    expect(st.crawl4ai).toHaveProperty('health_age_ms')
  })
})

describe('getOdds route vers crawl4ai', () => {
  test('un resultat crawl4ai est tagge _scraper=crawl4ai', async () => {
    crawl4ai.isAvailable.mockReturnValue(true)
    crawl4ai.getOdds.mockResolvedValue({
      home_win: 2.1,
      draw: 3.4,
      away_win: 3.8,
    })
    const out = await router.getOdds('Arsenal', 'Liverpool', 'Premier League', { skipFreeProxy: true })
    expect(out).not.toBeNull()
    expect(out._scraper).toBe('crawl4ai')
    expect(typeof out._mode).toBe('string')
  })

  test('preferSource=crawl4ai ne tente que crawl4ai', async () => {
    const bypass = require('../services/scrapers/ScrapingBypassScraper')
    crawl4ai.isAvailable.mockReturnValue(true)
    crawl4ai.getOdds.mockResolvedValue({ home_win: 2.0, away_win: 3.9 })
    bypass.getOdds.mockClear()
    const out = await router.getOdds('Arsenal', 'Liverpool', 'Premier League', {
      skipFreeProxy: true,
      preferSource: 'crawl4ai',
    })
    expect(out._scraper).toBe('crawl4ai')
    expect(bypass.getOdds).not.toHaveBeenCalled()
  })

  test('retourne null quand crawl4ai echoue partout (aucune source exploitable)', async () => {
    crawl4ai.isAvailable.mockReturnValue(true)
    crawl4ai.getOdds.mockResolvedValue(null)
    const out = await router.getOdds('Arsenal', 'Liverpool', 'Premier League', { skipFreeProxy: true })
    expect(out).toBeNull()
  })
})

describe('getResults tente crawl4ai', () => {
  test('retourne les resultats crawl4ai quand disponibles', async () => {
    crawl4ai.isAvailable.mockReturnValue(true)
    crawl4ai.getResults.mockResolvedValue([{ home_team: 'A', away_team: 'B', status: 'finished' }])
    const res = await router.getResults('Premier League')
    expect(res).toHaveLength(1)
  })

  test('retourne un tableau vide quand crawl4ai est indisponible', async () => {
    crawl4ai.isAvailable.mockReturnValue(false)
    const res = await router.getResults('Premier League')
    expect(Array.isArray(res)).toBe(true)
  })
})
