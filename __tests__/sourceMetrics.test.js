const { computeSourceMetrics, detectSilentFailure } = require('../services/sourceMetrics')

function scan({ fetched, newCount, error, at, source = 'livescore' }) {
  return {
    startedAt: at,
    finishedAt: at,
    dates: ['2026-08-13'],
    sources: { [source]: { fetched, new: newCount, error } },
    coverage: { totalUnique: newCount, new: newCount, mena: 0 },
  }
}

describe('computeSourceMetrics', () => {
  it('returns {} for empty history', () => {
    expect(computeSourceMetrics([])).toEqual({})
  })

  it('aggregates per-source scans, successes, failures, averages', () => {
    const history = [
      scan({ fetched: 100, newCount: 10, at: 't1' }),
      scan({ fetched: 200, newCount: 0, at: 't2' }),
      scan({ fetched: 0, newCount: 0, error: 'timeout: x', at: 't3', source: 'livescore' }),
      scan({ fetched: 0, newCount: 0, at: 't4', source: 'openligadb' }),
    ]
    const m = computeSourceMetrics(history)
    expect(m.livescore).toMatchObject({
      scans: 3,
      successes: 2,
      failures: 1,
      avgFetched: 100, // (100+200+0)/3
      avgNew: 3, // (10+0+0)/3 = 3.33 -> 3
      successRate: 2 / 3,
      lastError: 'timeout: x',
      lastErrorAt: 't3',
      lastScanAt: 't3',
    })
    expect(m.openligadb.scans).toBe(1)
    expect(m.openligadb.failures).toBe(0)
  })
})

describe('detectSilentFailure', () => {
  const dataScans = [scan({ fetched: 500, newCount: 40, at: 't1' }), scan({ fetched: 300, newCount: 20, at: 't2' })]

  it('is false with not enough history', () => {
    expect(detectSilentFailure([], 'livescore', 3)).toBe(false)
    expect(detectSilentFailure([scan({ fetched: 0, newCount: 0, at: 't1' })], 'livescore', 3)).toBe(false)
  })

  it('is true when source returns 0 for the whole window after having data', () => {
    const empty = [scan({ fetched: 0, newCount: 0, at: 't3' }), scan({ fetched: 0, newCount: 0, at: 't4' }), scan({ fetched: 0, newCount: 0, at: 't5' })]
    expect(detectSilentFailure([...dataScans, ...empty], 'livescore', 3)).toBe(true)
  })

  it('is false when the source still returns data in the window', () => {
    const mixed = [scan({ fetched: 0, newCount: 0, at: 't3' }), scan({ fetched: 100, newCount: 5, at: 't4' }), scan({ fetched: 0, newCount: 0, at: 't5' })]
    expect(detectSilentFailure([...dataScans, ...mixed], 'livescore', 3)).toBe(false)
  })

  it('is false when the source errored (not silent)', () => {
    const errored = [scan({ fetched: 0, newCount: 0, error: 'http: 500', at: 't3' }), scan({ fetched: 0, newCount: 0, error: 'http: 500', at: 't4' }), scan({ fetched: 0, newCount: 0, error: 'http: 500', at: 't5' })]
    expect(detectSilentFailure([...dataScans, ...errored], 'livescore', 3)).toBe(false)
  })

  it('is false when source never produced data before', () => {
    const allEmpty = [scan({ fetched: 0, newCount: 0, at: 't1' }), scan({ fetched: 0, newCount: 0, at: 't2' }), scan({ fetched: 0, newCount: 0, at: 't3' }), scan({ fetched: 0, newCount: 0, at: 't4' })]
    expect(detectSilentFailure(allEmpty, 'livescore', 3)).toBe(false)
  })

  it('is false when the failing source is a different one', () => {
    const empty = [scan({ fetched: 0, newCount: 0, at: 't3' }), scan({ fetched: 0, newCount: 0, at: 't4' }), scan({ fetched: 0, newCount: 0, at: 't5' })]
    expect(detectSilentFailure([...dataScans, ...empty], 'openligadb', 3)).toBe(false)
  })
})
