const marketAnalysis = require('../services/marketAnalysisService')

describe('marketAnalysisService.cornersVerdict', () => {
  test('returns a valid verdict structure', () => {
    const v = marketAnalysis.cornersVerdict(1.5, 1.2)
    expect(v).toMatchObject({
      line: 10.5,
      expectedTotal: expect.any(Number),
      over: expect.any(Number),
      under: expect.any(Number),
    })
    expect(v.over + v.under).toBeCloseTo(1, 5)
    expect(v.expectedTotal).toBeCloseTo(7.6, 1)
  })

  test('high xG total pushes the verdict to Over', () => {
    const v = marketAnalysis.cornersVerdict(2.0, 1.8, 9.5)
    expect(v.over).toBeGreaterThan(v.under)
    expect(v.label.startsWith('O 9.5')).toBe(true)
  })

  test('low xG total pushes the verdict to Under', () => {
    const v = marketAnalysis.cornersVerdict(0.8, 0.6, 11.5)
    expect(v.under).toBeGreaterThan(v.over)
    expect(v.label.startsWith('U 11.5')).toBe(true)
  })

  test('label encodes verdict, line and rounded probability', () => {
    const v = marketAnalysis.cornersVerdict(1.5, 1.2)
    expect(v.label).toMatch(/^[OU] \d+\.\d \d+%$/)
    expect(v.label.endsWith('%')).toBe(true)
  })

  test('is deterministic (no randomness)', () => {
    const a = marketAnalysis.cornersVerdict(1.4, 1.3, 10.5)
    const b = marketAnalysis.cornersVerdict(1.4, 1.3, 10.5)
    expect(a).toEqual(b)
  })

  test('exposes fair odds consistent with probabilities', () => {
    const v = marketAnalysis.cornersVerdict(1.5, 1.2)
    expect(v.fairUnder).toBeCloseTo(1 / v.under, 1)
    expect(v.fairOver).toBeCloseTo(1 / v.over, 1)
  })

  test('guards against zero/negative xG inputs', () => {
    const v = marketAnalysis.cornersVerdict(0, 0)
    expect(v.expectedTotal).toBeGreaterThanOrEqual(1)
    expect(v.under).toBeGreaterThanOrEqual(0)
    expect(v.over).toBeGreaterThanOrEqual(0)
  })
})

describe('marketAnalysisService.ensureOuLines', () => {
  test('adds the 4 explicit O/U lines (O1.5/U1.5/O4.5/U4.5)', () => {
    const markets = {
      over_under: { 'O2.5': { prob: 0.6 }, 'U2.5': { prob: 0.4 } },
    }
    marketAnalysis.ensureOuLines(markets, 1.5, 1.2)
    const ou = markets.over_under
    for (const k of ['O1.5', 'U1.5', 'O4.5', 'U4.5']) {
      expect(typeof ou[k].prob).toBe('number')
      expect(ou[k].prob).toBeGreaterThan(0)
      expect(ou[k].prob).toBeLessThan(1)
    }
    expect(ou['O1.5'].prob).toBeGreaterThan(ou['O4.5'].prob)
  })

  test('is idempotent — never overrides an existing line', () => {
    const markets = {
      over_under: {
        'O2.5': { prob: 0.6 },
        'U2.5': { prob: 0.4 },
        'O1.5': { prob: 0.99, odds: 9.9 },
      },
    }
    marketAnalysis.ensureOuLines(markets, 1.5, 1.2)
    expect(markets.over_under['O1.5']).toEqual({ prob: 0.99, odds: 9.9 })
  })

  test('short-circuits when all 4 lines already exist', () => {
    const markets = {
      over_under: {
        'O1.5': { prob: 0.9 },
        'U1.5': { prob: 0.1 },
        'O2.5': { prob: 0.6 },
        'U2.5': { prob: 0.4 },
        'O3.5': { prob: 0.4 },
        'U3.5': { prob: 0.6 },
        'O4.5': { prob: 0.2 },
        'U4.5': { prob: 0.8 },
      },
    }
    const before = JSON.stringify(markets.over_under)
    marketAnalysis.ensureOuLines(markets, 1.5, 1.2)
    expect(JSON.stringify(markets.over_under)).toBe(before)
  })

  test('tolerates missing xG (falls back to league base)', () => {
    const markets = { over_under: { 'O2.5': { prob: 0.6 }, 'U2.5': { prob: 0.4 } } }
    expect(() => marketAnalysis.ensureOuLines(markets, 0, 0)).not.toThrow()
    expect(markets.over_under['O1.5']).toBeDefined()
  })

  test('returns markets unchanged when there is no over_under section', () => {
    const markets = { match_result: {} }
    expect(marketAnalysis.ensureOuLines(markets, 1.5, 1.2)).toBe(markets)
  })
})

describe('marketAnalysisService legacy corners', () => {
  test('corners() still returns results per line', () => {
    const c = marketAnalysis.corners(1.5, 1.2)
    expect(Array.isArray(c)).toBe(true)
    expect(c.length).toBeGreaterThan(0)
    expect(typeof c[0].expectedTotal).toBe('number')
  })
})
