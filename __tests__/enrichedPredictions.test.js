/**
 * Enriched Predictions Unit Tests
 * Tests for core/enriched_predictions.js - Match enrichment logic
 */

jest.mock('axios', () => ({
  get: jest.fn().mockRejectedValue(new Error('Mocked network')),
  post: jest.fn().mockRejectedValue(new Error('Mocked network')),
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  })),
}))

jest.mock('../services/dataFusionService', () => ({
  fetchOdds: jest.fn().mockResolvedValue(null),
}))

jest.mock('../services/scrapers', () => ({
  getOdds: jest.fn().mockResolvedValue(null),
  getLiveScores: jest.fn().mockResolvedValue([]),
  getResults: jest.fn().mockResolvedValue([]),
  getStatus: jest.fn(() => ({})),
  setMode: jest.fn(() => true),
  getMode: jest.fn(() => 'jina_primary'),
  isHealthy: jest.fn(() => true),
  resetHealth: jest.fn(),
}))

jest.mock('../core/pythonService', () => ({
  predict: jest.fn().mockRejectedValue(new Error('Mocked')),
}))

jest.mock('../services/weatherService', () => ({
  isAvailable: jest.fn().mockReturnValue(false),
  fetchByCity: jest.fn(),
  extractWeatherInfo: jest.fn(),
}))

jest.mock('../services/oddsMovementService', () => ({
  detectBookmakerTrap: jest.fn(() => ({ isTrap: false })),
  getSteamForMatch: jest.fn(),
  snapshotOdds: jest.fn(),
}))

jest.mock('../core/services/StatisticalEngine', () => ({
  getMatchXG: jest.fn().mockReturnValue({ h: 1.5, a: 1.2 }),
  getGoalModelParams: jest.fn().mockReturnValue({ rho: -0.12, gamma: 1.0 }),
  applyGamma: jest.fn().mockImplementation((h, a) => ({ h, a })),
  predictCorners: jest.fn().mockReturnValue({ home: 5, away: 3 }),
  predictCards: jest.fn().mockReturnValue({ home: 2, away: 3 }),
  predictGoals: jest.fn().mockReturnValue({ home: 1.8, away: 1.2 }),
  getPoissonProb: jest.fn().mockReturnValue(0.15),
  deriveXgFromOdds: jest.fn().mockReturnValue({ h: 1.5, a: 1.2 }),
  _getLeagueBaseXG: jest.fn().mockReturnValue({ h: 1.5, a: 1.2 }),
}))

jest.mock('../core/QuantumQuantEngine', () => ({
  analyze: jest.fn().mockReturnValue({
    markets: {
      match_result: { 1: { prob: 0.45 }, X: { prob: 0.25 }, 2: { prob: 0.3 } },
    },
    expected_score: '2 - 1',
    risk_label: 'CONFIDENT',
    main_pick: 'HOME',
    secondary_pick: 'OVER 2.5',
    ev_score: 0.15,
    edge_score: 0.05,
    confidence: 75,
    probs: { btts: 0.55, over25: 0.6, ht_goal: 0.45 },
    all_picks: [{ label: 'HOME', prob: 0.45, ev: 0.15 }],
    massive_edge: false,
    signal_strength: 'NORMAL',
  }),
}))

jest.mock('../src/services/newsService', () => {
  function MockCache() {
    this.get = jest.fn()
    this.set = jest.fn()
  }
  return {
    getMatchIntelligence: jest.fn().mockResolvedValue({
      home: { headlines: [], injuries: [] },
      away: { headlines: [], injuries: [] },
    }),
    NewsCache: MockCache,
  }
})

jest.mock('../src/services/oddsService', () => ({
  getLiveOdds: jest.fn().mockResolvedValue(null),
}))

const enrichedPredictions = require('../core/enriched_predictions')

// Stub getAnalyticalPrediction to return a clean mock — avoids all Python/network
const MOCK_ANALYTICAL = {
  success: true,
  home_win_probability: 55,
  draw_probability: 25,
  away_win_probability: 20,
  confidence: 70,
  expected_score: '1 - 1',
}
enrichedPredictions.getAnalyticalPrediction = jest.fn().mockResolvedValue(MOCK_ANALYTICAL)
enrichedPredictions._tryBayesianLowData = jest.fn().mockResolvedValue(null)

describe('EnrichedPredictions', () => {
  describe('fastEnrichMatch()', () => {
    it('should enrich a match with AI predictions', async () => {
      const match = {
        id: 'match-1',
        homeTeam: 'Barcelona',
        awayTeam: 'Real Madrid',
        league: 'La Liga',
        odds_home: 1.95,
        odds_draw: 3.4,
        odds_away: 3.9,
        ou_25_prob: null,
        btts_prob: null,
      }

      const enriched = await enrichedPredictions.fastEnrichMatch(match)

      expect(enriched).toBeDefined()
      expect(enriched).toHaveProperty('home_win_probability')
      expect(enriched).toHaveProperty('draw_probability')
      expect(enriched).toHaveProperty('away_win_probability')
      expect(enriched).toHaveProperty('expected_score')
      expect(enriched).toHaveProperty('enriched')
    })

    it('should preserve original match data', async () => {
      const original = {
        id: 'match-2',
        homeTeam: 'PSG',
        awayTeam: 'Marseille',
        league: 'Ligue 1',
        customField: 'custom-value',
      }

      const enriched = await enrichedPredictions.fastEnrichMatch(original)

      expect(enriched.customField).toBe('custom-value')
      expect(enriched.home_win_probability).toBeDefined()
    })

    it('should recalculate probabilities from engine (not preserve stale values)', async () => {
      const match = {
        id: 'match-3',
        homeTeam: 'Bayern',
        awayTeam: 'Dortmund',
        home_win_probability: 80.0,
        draw_probability: 12.0,
        away_win_probability: 8.0,
      }

      const enriched = await enrichedPredictions.fastEnrichMatch(match)

      expect(enriched.home_win_probability).toBeDefined()
      expect(enriched.home_win_probability).not.toBe(80.0)
      expect(enriched.expected_score).toBeDefined()
      expect(enriched.expected_score).toMatch(/\d+\s*-\s*\d+/)
    })

    it('should generate expected score', async () => {
      const match = {
        id: 'match-4',
        homeTeam: 'Liverpool',
        awayTeam: 'Chelsea',
      }

      const enriched = await enrichedPredictions.fastEnrichMatch(match)

      expect(enriched.expected_score).toBeDefined()
      expect(typeof enriched.expected_score).toBe('string')
      expect(enriched.expected_score).toMatch(/\d+\s*-\s*\d+/)
    })
  })

  describe('enrichMatch()', () => {
    it('should produce full enriched object', async () => {
      const match = {
        id: 'match-5',
        homeTeam: 'Arsenal',
        awayTeam: 'Man City',
        league: 'Premier League',
        startTimestamp: Math.floor(Date.now() / 1000) + 86400,
        odds_home: 2.5,
        odds_draw: 3.2,
        odds_away: 2.8,
      }

      const enriched = await enrichedPredictions.enrichMatch(match)

      expect(enriched).toHaveProperty('enriched')
      expect(enriched.enriched).toHaveProperty('winner')
      expect(enriched.enriched).toHaveProperty('winnerProbability')
      expect(enriched.enriched).toHaveProperty('predictedGoals')
      expect(enriched.enriched).toHaveProperty('predictedCorners')
      expect(enriched.enriched).toHaveProperty('bankroll_advice')
    })

    it('should include master_v20 analysis', async () => {
      const match = {
        id: 'match-6',
        homeTeam: 'Atletico',
        awayTeam: 'Sevilla',
        league: 'La Liga',
      }

      const enriched = await enrichedPredictions.enrichMatch(match)

      expect(enriched.enriched).toHaveProperty('master_v20')
      expect(enriched.enriched.master_v20).toHaveProperty('master_verdict')
      expect(enriched.enriched.master_v20).toHaveProperty('node_count')
    })

    it('should handle matches without odds', async () => {
      const match = {
        id: 'match-7',
        homeTeam: 'Team X',
        awayTeam: 'Team Y',
      }

      const enriched = await enrichedPredictions.enrichMatch(match)

      expect(enriched).toBeDefined()
      expect(enriched.enriched.winner).toBeDefined()
    })

    it('should produce consistent winner selection', async () => {
      const match = {
        id: 'match-8',
        homeTeam: 'Strong Team',
        awayTeam: 'Weak Team',
        home_win_probability: 70,
        away_win_probability: 15,
      }

      const enriched = await enrichedPredictions.enrichMatch(match)

      expect(enriched.enriched.winner).toBe('Strong Team')
      expect(enriched.enriched.winnerProbability).toBeGreaterThan(0.5)
    })
  })
})
