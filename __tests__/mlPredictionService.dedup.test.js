/**
 * É8 (audit 2026-09-10) : déduplication in-flight sans fenêtre de course +
 * clé de cache qui dépend des paramètres de prédiction (cotes, minute, marchés).
 */

jest.mock('../core/redisClient', () => {
  const cache = new Map()
  return {
    __cache: cache,
    getCache: jest.fn(async (k) => (cache.has(k) ? cache.get(k) : null)),
    setCache: jest.fn(async (k, v) => {
      cache.set(k, v)
      return true
    }),
  }
})

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/pythonService', () => ({
  predict: jest.fn(async () => {
    await new Promise((r) => setTimeout(r, 20))
    return { success: true, verdict: 'HOME', home_win_probability: 55 }
  }),
}))

jest.mock('../core/database', () => ({
  getMatchById: jest.fn(async () => {
    await new Promise((r) => setTimeout(r, 10))
    return null
  }),
  updatePredictions: jest.fn(async () => {}),
}))

jest.mock('../core/confluenceGuardV2', () => ({
  load: async () => {},
  evaluate: () => ({ veto: false, adjustedConfidence: 60, adjustments: {} }),
}))

jest.mock('../services/oddsMovementAnalyzer', () => ({
  getSignal: () => null,
  applyToPrediction: (_id, r) => r,
}))

jest.mock('../services/visualEnrichmentService', () => ({
  getVisualContext: jest.fn(async () => null),
}))

jest.mock('../services/visualSignals', () => ({ auditSignal: jest.fn() }))

beforeEach(() => {
  jest.clearAllMocks()
})

function freshService() {
  jest.resetModules()
  // re-appliquer les mocks après resetModules : jest.mock est hoisted par fichier,
  // mais le registre est neuf -> on repeuple via require du MEME registre (jest
  // réenregistre les mocks automatiquement). Rien à faire ici.
  return require('../services/mlPredictionService')
}

const baseMatch = {
  id: 'm-dedup-1',
  homeTeam: 'A',
  awayTeam: 'B',
  league: 'Liga 1',
  odds_home: 1.9,
  odds_draw: 3.4,
  odds_away: 3.9,
}

describe('mlPredictionService — dédup in-flight (pas de fenêtre de course)', () => {
  it('2 appels simultanés du même match => UN seul /predict Python', async () => {
    const svc = freshService()
    const pythonService = require('../core/pythonService')
    const [r1, r2] = await Promise.all([
      svc.getMLPrediction({ ...baseMatch }),
      svc.getMLPrediction({ ...baseMatch }),
    ])
    expect(pythonService.predict).toHaveBeenCalledTimes(1)
    expect(r1.success).toBe(true)
    expect(r2).toBe(r1)
  })
})

describe('mlPredictionService — clé de cache paramétrée', () => {
  it('mêmes paramètres => HIT cache (pas de 2e appel Python)', async () => {
    const svc = freshService()
    const pythonService = require('../core/pythonService')
    await svc.getMLPrediction({ ...baseMatch })
    await svc.getMLPrediction({ ...baseMatch })
    expect(pythonService.predict).toHaveBeenCalledTimes(1)
  })

  it('cotes différentes => pas de HIT (pas de prédiction périmée resservie)', async () => {
    const svc = freshService()
    const pythonService = require('../core/pythonService')
    await svc.getMLPrediction({ ...baseMatch })
    await svc.getMLPrediction({ ...baseMatch, odds_home: 1.55 })
    expect(pythonService.predict).toHaveBeenCalledTimes(2)
    const keys = [...require('../core/redisClient').__cache.keys()]
    expect(new Set(keys.map((k) => k.split(':')[1])).size).toBe(1) // même matchId
    expect(new Set(keys).size).toBe(2) // signatures différentes
  })

  it('minute différente => pas de HIT', async () => {
    const svc = freshService()
    const pythonService = require('../core/pythonService')
    await svc.getMLPrediction({ ...baseMatch, minute: 12 })
    await svc.getMLPrediction({ ...baseMatch, minute: 31 })
    expect(pythonService.predict).toHaveBeenCalledTimes(2)
  })
})
