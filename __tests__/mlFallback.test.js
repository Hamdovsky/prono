/**
 * ML Fallback Tests
 * Tests for enriched_predictions.getAnalyticalPrediction JS fallback
 * when Python service is unavailable on Render.
 */

jest.mock('../core/pythonService', () => ({
  predict: jest.fn()
}))

const enrichedPredictions = require('../core/enriched_predictions')
const pythonService = require('../core/pythonService')

beforeEach(() => {
  jest.clearAllMocks()
})

describe('getAnalyticalPrediction JS Fallback', () => {
  it('should fallback when Python returns success:false', async () => {
    pythonService.predict.mockResolvedValue({ success: false, error: 'Flask offline' })

    const match = {
      id: 'fallback-test-1',
      homeTeam: 'Barcelona',
      awayTeam: 'Real Madrid',
      odds_home: 2.10,
      odds_draw: 3.40,
      odds_away: 3.50
    }

    const result = await enrichedPredictions.getAnalyticalPrediction(match)
    expect(result.success).toBe(true)
    expect(result).toHaveProperty('home_win_probability')
    expect(result).toHaveProperty('draw_probability')
    expect(result).toHaveProperty('away_win_probability')
    expect(result).toHaveProperty('expected_score')
    expect(result).toHaveProperty('verdict')
    expect(result).toHaveProperty('confidence')
  })

  it('should fallback when Python throws', async () => {
    pythonService.predict.mockRejectedValue(new Error('Connection refused'))

    const match = {
      id: 'fallback-test-2',
      homeTeam: 'PSG',
      awayTeam: 'Marseille',
      odds_home: 1.50,
      odds_draw: 4.00,
      odds_away: 6.00
    }

    const result = await enrichedPredictions.getAnalyticalPrediction(match)
    expect(result.success).toBe(true)
    expect(result).toHaveProperty('home_win_probability')
    expect(result).toHaveProperty('draw_probability')
    expect(result).toHaveProperty('away_win_probability')
  })

  it('should return probabilities summing near 100', async () => {
    pythonService.predict.mockResolvedValue({ success: false })

    const result = await enrichedPredictions.getAnalyticalPrediction({
      id: 'prob-sum',
      homeTeam: 'Bayern',
      awayTeam: 'Dortmund',
      odds_home: 1.80,
      odds_draw: 3.60,
      odds_away: 4.20
    })

    const total = result.home_win_probability + result.draw_probability + result.away_win_probability
    expect(total).toBeGreaterThan(95)
    expect(total).toBeLessThan(105)
  })

  it('should produce deterministic output for same input', async () => {
    pythonService.predict.mockResolvedValue({ success: false })

    const match = {
      id: 'deterministic',
      homeTeam: 'Liverpool',
      awayTeam: 'Chelsea',
      odds_home: 2.00,
      odds_draw: 3.30,
      odds_away: 3.80
    }

    const [r1, r2] = await Promise.all([
      enrichedPredictions.getAnalyticalPrediction({ ...match }),
      enrichedPredictions.getAnalyticalPrediction({ ...match })
    ])

    expect(r1.home_win_probability).toBe(r2.home_win_probability)
    expect(r1.expected_score).toBe(r2.expected_score)
  })
})
