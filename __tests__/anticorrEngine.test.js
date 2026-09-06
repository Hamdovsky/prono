/**
 * Unit tests for generateAntiCorrelatedGrids (services/promosport_engine.js)
 * Synthetic matches exercising: safe LOCK (gap >= 0.15), finished matches,
 * uncertain rotation, cardinality, budget, determinism.
 */

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))
jest.mock('../services/mlPredictionService', () => ({ predict: jest.fn() }))
jest.mock('../services/doubleOptimizerService', () => ({
  simulateDoubleCounts: jest.fn(),
  selectOptimalDoubles: jest.fn(),
}))
jest.mock('../core/database', () => ({ getTeamAvgXg: jest.fn() }))
jest.mock('../services/promosportMLService', () => ({ predictBatch: jest.fn() }))
jest.mock('../core/services/StatisticalEngine', () => ({
  getMatchXG: jest.fn(),
  calculatePoissonProbs: jest.fn(),
}))
jest.mock('../services/scrapers/ScrapingBypassScraper', () => ({ scrape: jest.fn() }))
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }))

const { generateAntiCorrelatedGrids } = require('../services/promosport_engine')

// 13 synthetic matches:
//  idx 0: finished (locked actualResult 'X')
//  idx 1,2: safe home (gap 0.50 / 0.44)
//  idx 3-12: uncertain (gap < 0.15), mixed shapes
const matches = Array.from({ length: 13 }, (_, i) => ({
  id: i + 1,
  homeTeam: `Home${i}`,
  awayTeam: `Away${i}`,
  entropy: 1.2 + (i % 5) * 0.2,
  confidence: 55 + i,
})).map((m, i) => {
  if (i === 0) {
    return {
      ...m,
      p1: 0.2,
      px: 0.5,
      p2: 0.3,
      isFinished: true,
      actualResult: 'X',
    }
  }
  if (i === 1) {
    return { ...m, p1: 0.7, px: 0.2, p2: 0.1 } // gap 0.50
  }
  if (i === 2) {
    return { ...m, p1: 0.66, px: 0.22, p2: 0.12 } // gap 0.44
  }
  // uncertain triangle
  return { ...m, p1: 0.36, px: 0.33, p2: 0.31 }
})

describe('generateAntiCorrelatedGrids', () => {
  it('returns exactly N grids with 13 singles/matches each', () => {
    const grids = generateAntiCorrelatedGrids(matches, 8)
    expect(grids).toHaveLength(8)
    grids.forEach((g) => {
      expect(g.matches).toHaveLength(13)
      expect(g.stats.totalDoubles).toBe(0)
      expect(g.stats.totalSingles).toBe(13)
    })
  })

  it('locks finished matches on the actual result', () => {
    const grids = generateAntiCorrelatedGrids(matches, 8)
    grids.forEach((g) => {
      expect(g.matches[0].choices).toEqual(['X'])
      expect(g.matches[0].inUncertain).toBe(false)
    })
  })

  it('keeps safe matches (gap >= 0.15) locked on the favourite', () => {
    const grids = generateAntiCorrelatedGrids(matches, 8)
    grids.forEach((g) => {
      expect(g.matches[1].choices).toEqual(['1'])
      expect(g.matches[2].choices).toEqual(['1'])
    })
  })

  it('diversifies uncertain matches across grids', () => {
    const grids = generateAntiCorrelatedGrids(matches, 8)
    const picksPerMatch = { 3: new Set(), 4: new Set(), 5: new Set() }
    grids.forEach((g) => {
      ;[3, 4, 5].forEach((idx) => picksPerMatch[idx].add(g.matches[idx].choices[0]))
    })
    ;[3, 4, 5].forEach((idx) => {
      expect(picksPerMatch[idx].size).toBeGreaterThanOrEqual(2)
    })
    // grid 0 = argmax (home favourite) on a defined favourite, rest rotated
    ;[3, 4, 5].forEach((idx) => {
      expect(grids[0].matches[idx].choices[0]).toBe('1')
    })
  })

  it('is deterministic for identical inputs', () => {
    const a = generateAntiCorrelatedGrids(matches, 8)
    const b = generateAntiCorrelatedGrids(matches, 8)
    expect(a).toEqual(b)
  })

  it('handles empty/undefined inputs gracefully', () => {
    expect(generateAntiCorrelatedGrids([])).toEqual([])
    expect(generateAntiCorrelatedGrids(null)).toEqual([])
  })
})