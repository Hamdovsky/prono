const { SourceHealthTracker } = require('../services/sourceHealth')

describe('SourceHealthTracker', () => {
  beforeEach(() => {
    jest.useRealTimers()
  })

  it('is usable by default for an unknown source', () => {
    const t = new SourceHealthTracker()
    expect(t.isUsable('livescore')).toBe(true)
  })

  it('disables a source after failThreshold consecutive failures', () => {
    const t = new SourceHealthTracker({ failThreshold: 3, cooldownMs: 60000 })
    expect(t.isUsable('sofascore')).toBe(true)
    t.recordFailure('sofascore', 'http')
    t.recordFailure('sofascore', 'http')
    expect(t.isUsable('sofascore')).toBe(true)
    t.recordFailure('sofascore', 'http')
    expect(t.isUsable('sofascore')).toBe(false)
  })

  it('reports cooldown remaining and error type', () => {
    const t = new SourceHealthTracker({ failThreshold: 1, cooldownMs: 5000 })
    t.recordFailure('livescore', 'timeout')
    const status = t.getStatus()
    expect(status.livescore.disabled).toBe(true)
    expect(status.livescore.lastErrorType).toBe('timeout')
    expect(status.livescore.cooldownRemainingMs).toBeGreaterThan(0)
    expect(status.livescore.cooldownRemainingMs).toBeLessThanOrEqual(5000)
  })

  it('auto re-enables after cooldown elapses', () => {
    jest.useFakeTimers()
    const t = new SourceHealthTracker({ failThreshold: 1, cooldownMs: 5000 })
    t.recordFailure('livescore', 'empty')
    expect(t.isUsable('livescore')).toBe(false)
    jest.advanceTimersByTime(5001)
    expect(t.isUsable('livescore')).toBe(true)
  })

  it('recordSuccess resets failures immediately', () => {
    const t = new SourceHealthTracker({ failThreshold: 2, cooldownMs: 60000 })
    t.recordFailure('openligadb', 'network')
    t.recordFailure('openligadb', 'network')
    expect(t.isUsable('openligadb')).toBe(false)
    t.recordSuccess('openligadb')
    expect(t.isUsable('openligadb')).toBe(true)
    expect(t.getStatus().openligadb.failures).toBe(0)
  })

  it('getStatus lists every tracked source', () => {
    const t = new SourceHealthTracker()
    t.recordFailure('a', 'http')
    t.recordSuccess('b')
    const s = t.getStatus()
    expect(Object.keys(s)).toContain('a')
    expect(Object.keys(s)).toContain('b')
  })

  it('reads thresholds from env', () => {
    process.env.SOURCE_FAIL_THRESHOLD = '5'
    process.env.SOURCE_COOLDOWN_MS = '1000'
    const t = new SourceHealthTracker()
    expect(t.failThreshold).toBe(5)
    expect(t.cooldownMs).toBe(1000)
    delete process.env.SOURCE_FAIL_THRESHOLD
    delete process.env.SOURCE_COOLDOWN_MS
  })

  it('uses exponential backoff by default (no fixed cooldownMs)', () => {
    const t = new SourceHealthTracker({ failThreshold: 2 })
    t.recordFailure('livescore', 'http')
    t.recordFailure('livescore', 'http') // enters cooldown -> base (60s)
    const d1 = t.sources.livescore.cooldownUntil - Date.now()
    expect(d1).toBeGreaterThan(0)
    expect(d1).toBeLessThanOrEqual(60000)
    // cooldown elapses, fails again 2x -> backoff doubles (120s)
    t.sources.livescore.cooldownUntil = 0
    t.recordFailure('livescore', 'http')
    t.recordFailure('livescore', 'http')
    const d2 = t.sources.livescore.cooldownUntil - Date.now()
    expect(d2).toBeGreaterThan(120000)
    expect(d2).toBeLessThanOrEqual(240000)
  })

  it('caps exponential backoff at backoffMaxMs', () => {
    const t = new SourceHealthTracker({ failThreshold: 1, backoffBaseMs: 1000, backoffMaxMs: 4000 })
    for (let i = 0; i < 10; i++) t.recordFailure('livescore', 'http')
    expect(t.sources.livescore.cooldownUntil - Date.now()).toBeLessThanOrEqual(4000)
  })

  it('fixed cooldownMs overrides backoff', () => {
    const t = new SourceHealthTracker({ failThreshold: 1, cooldownMs: 3000, backoffBaseMs: 60000 })
    t.recordFailure('livescore', 'http')
    expect(t.sources.livescore.cooldownUntil - Date.now()).toBeLessThanOrEqual(3000)
  })
})