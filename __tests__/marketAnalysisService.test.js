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

describe('marketAnalysisService legacy corners', () => {
  test('corners() still returns results per line', () => {
    const c = marketAnalysis.corners(1.5, 1.2)
    expect(Array.isArray(c)).toBe(true)
    expect(c.length).toBeGreaterThan(0)
    expect(typeof c[0].expectedTotal).toBe('number')
  })
})
