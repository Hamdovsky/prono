const fs = require('fs')
const os = require('os')
const path = require('path')
const { SourceOrchestrator } = require('../services/sourceOrchestrator')
const { getOrComputeMatchKey } = require('../services/matchKey')

const TS = Math.floor(Date.UTC(2026, 7, 13, 18, 0, 0) / 1000) // seconds (Livescore style)

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `orchestrator-test-${prefix}-${process.pid}.json`)
}

function makeMatch(home, away, league, source = 'livescore') {
  return { homeTeam: home, awayTeam: away, league, source, startTimestamp: TS }
}

describe('SourceOrchestrator', () => {
  let logPath
  let statePath

  beforeEach(() => {
    logPath = tmpFile('log')
    statePath = tmpFile('state')
  })

  afterEach(() => {
    for (const p of [logPath, statePath]) {
      try { fs.unlinkSync(p) } catch (_) {}
    }
  })

  function orchestrator(providers, { store, telegram, historyPath: hp } = {}) {
    return new SourceOrchestrator({
      providers,
      store,
      telegram,
      logPath,
      statePath,
      historyPath: hp || path.join(os.tmpdir(), `orchestrator-hist-${process.pid}.json`),
    })
  }

  it('dedupes the same match across providers (highest priority wins)', async () => {
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] }
    const p2 = { name: 'sofascore', priority: 2, fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] }
    const persisted = []
    const store = {
      getExistingKeys: async () => new Map(),
      persist: async (m, k) => { persisted.push(k) },
    }
    const s = orchestrator([p1, p2], { store })
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(res.coverage.totalUnique).toBe(1)
    expect(res.sources.livescore.new).toBe(1)
    expect(res.sources.sofascore.new).toBe(0)
    expect(persisted.length).toBe(1)
  })

  it('skips matches already present in the store', async () => {
    const existing = new Map()
    existing.set('real madrid|barcelona|20260813', { id: 'x' })
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] }
    const store = {
      getExistingKeys: async () => existing,
      persist: async () => {},
    }
    const s = orchestrator([p1], { store })
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(res.coverage.totalUnique).toBe(0)
    expect(res.sources.livescore.new).toBe(0)
  })

  it('skips providers in cooldown and records it', async () => {
    const fetch = jest.fn(async () => [makeMatch('A', 'B', 'X')])
    const p1 = { name: 'broken', priority: 1, fetch }
    // pre-fail twice to reach threshold with default threshold 3 -> not yet
    const s = orchestrator([p1])
    s.health.recordFailure('broken', 'http')
    s.health.recordFailure('broken', 'http')
    s.health.recordFailure('broken', 'http') // now disabled
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(fetch).not.toHaveBeenCalled()
    expect(res.skippedInCooldown).toContain('broken@2026-08-13')
  })

  it('re-enables a source after a success clears cooldown', async () => {
    const s = orchestrator([{ name: 'l', priority: 1, fetch: async () => [makeMatch('A', 'B', 'X')] }])
    s.health.recordFailure('l', 'http')
    s.health.recordFailure('l', 'http')
    s.health.recordFailure('l', 'http')
    expect(s.health.isUsable('l')).toBe(false)
    s.health.recordSuccess('l')
    expect(s.health.isUsable('l')).toBe(true)
  })

  it('sends Telegram alert when MENA coverage is 0', async () => {
    const sendAlert = jest.fn(async () => {})
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('Ajax', 'PSV', 'Eredivisie')] }
    const s = orchestrator([p1], { telegram: { sendAlert } })
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(res.coverage.mena).toBe(0)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(res.alertSent).toBe(true)
  })

  it('does NOT alert when MENA coverage is > 0', async () => {
    const sendAlert = jest.fn(async () => {})
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('CR Belouizdad', 'MC Alger', 'Algeria Ligue 1')] }
    const s = orchestrator([p1], { telegram: { sendAlert } })
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(res.coverage.mena).toBe(1)
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('classifies failures and records health', async () => {
    const p1 = { name: 'livescore', priority: 1, fetch: async () => { throw new Error('timeout of 20000ms exceeded') } }
    const s = orchestrator([p1])
    await s.runScan({ dates: ['2026-08-13'] })
    expect(s.health.getStatus().livescore.lastErrorType).toBe('timeout')
    expect(s.health.getStatus().livescore.failures).toBe(1)
  })

  it('cuts off a hanging provider after fetchTimeoutMs and continues', async () => {
    const hanging = { name: 'hung', priority: 1, fetch: () => new Promise(() => {}) } // never resolves
    const healthy = {
      name: 'ok',
      priority: 2,
      fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')],
    }
    const s = orchestrator([hanging, healthy], { fetchTimeoutMs: 50 })
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(s.health.getStatus().hung.lastErrorType).toBe('timeout')
    expect(res.sources.hung.error).toContain('timeout')
    // the healthy source still processed
    expect(res.coverage.totalUnique).toBe(1)
  })

  it('writes log and state (writeLog + writeState called)', async () => {
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] }
    const s = orchestrator([p1])
    const logSpy = jest.spyOn(s, 'writeLog')
    const stateSpy = jest.spyOn(s, 'writeState')
    const res = await s.runScan({ dates: ['2026-08-13'] })
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(stateSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0][0].coverage.totalUnique).toBe(1)
    expect(stateSpy.mock.calls[0][0].coverage.totalUnique).toBe(1)
    expect(res.coverage.totalUnique).toBe(1)
  })

  it('orders providers by priority', () => {
    const p1 = { name: 'b', priority: 2, fetch: async () => [] }
    const p2 = { name: 'a', priority: 1, fetch: async () => [] }
    const s = orchestrator([p1, p2])
    expect(s._orderedProviders().map((p) => p.name)).toEqual(['a', 'b'])
  })

  it('sends a cooldown alert when a source enters cooldown', async () => {
    const sendAlert = jest.fn(async () => {})
    const p1 = {
      name: 'livescore',
      priority: 1,
      fetch: async () => { throw new Error('403 Forbidden') },
    }
    const s = orchestrator([p1], { telegram: { sendAlert } })
    s.health.recordFailure('livescore', 'http')
    s.health.recordFailure('livescore', 'http')
    await s.runScan({ dates: ['2026-08-13'] })
    expect(s.health.isUsable('livescore')).toBe(false)
    expect(sendAlert).toHaveBeenCalled()
    expect(sendAlert.mock.calls[0][0]).toContain('cooldown')
  })

  it('throttles providers that declare a rate', async () => {
    const fetch = jest.fn(async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')])
    const p1 = { name: 'livescore', priority: 1, rate: { max: 6, perMs: 60000 }, fetch }
    const s = orchestrator([p1])
    await s.runScan({ dates: ['2026-08-13', '2026-08-14'] })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(s.rateLimiter.status('livescore')).toBeTruthy()
  })

  it('honors a provider-specific timeoutMs instead of the default', async () => {
    const slow = { name: 'slow', priority: 1, timeoutMs: 30, fetch: async () => { await new Promise((r) => setTimeout(r, 100)); return [] } }
    const s1 = orchestrator([slow])
    const r1 = await s1.runScan({ dates: ['2026-08-13'] })
    expect(r1.sources.slow.error).toMatch(/timeout/)

    const fast = { name: 'fast', priority: 1, timeoutMs: 500, fetch: async () => { await new Promise((r) => setTimeout(r, 100)); return [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] } }
    const s2 = orchestrator([fast])
    const r2 = await s2.runScan({ dates: ['2026-08-13'] })
    expect(r2.sources.fast.error).toBeNull()
    expect(r2.sources.fast.fetched).toBe(1)
  })

  it('writes scan history after each run', async () => {
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [makeMatch('Real Madrid', 'Barcelona', 'LaLiga')] }
    const s = orchestrator([p1])
    const historySpy = jest.spyOn(s, 'writeHistory')
    await s.runScan({ dates: ['2026-08-13'] })
    expect(historySpy).toHaveBeenCalledTimes(1)
    expect(historySpy.mock.calls[0][0].coverage.totalUnique).toBe(1)
  })

  it('sends a throttled silent-failure alert when the primary source is silent', async () => {
    const sendAlert = jest.fn(async () => {})
    const p1 = { name: 'livescore', priority: 1, fetch: async () => [] } // 0 rows, no error
    const s = orchestrator([p1], { telegram: { sendAlert } })
    // seed history with prior scans that produced data
    const growing = []
    for (let i = 0; i < 4; i++) {
      growing.push({
        finishedAt: `t${i}`,
        dates: ['2026-08-13'],
        sources: { livescore: { fetched: 100, new: 5, error: null } },
        coverage: { totalUnique: 5, new: 5, mena: 0 },
      })
    }
    jest.spyOn(s, 'writeHistory').mockImplementation((summary) => growing.push(summary))
    jest.spyOn(s, '_readHistory').mockImplementation(() => growing)
    // run 3 empty scans -> last 3 become silent
    for (let i = 0; i < 3; i++) {
      await s.runScan({ dates: ['2026-08-13'] })
    }
    const silentAlert = sendAlert.mock.calls.find((c) => c[0].includes('silencieuse'))
    expect(silentAlert).toBeTruthy()
    expect(s._lastSilentAlertAt).toBeGreaterThan(0)
  })

  it('runResultsScan updates stored fixtures by match_key via fetchResults', async () => {
    const updateResult = jest.fn(async (key, patch) => 1)
    const p1 = {
      name: 'livescore',
      priority: 1,
      fetch: async () => [],
      fetchResults: async () => [
        {
          id: 'livescore_99',
          homeTeam: 'FC Copenhagen',
          awayTeam: 'Debrecen',
          league: 'Qualification',
          startTimestamp: 1755000000,
          status: 'finished',
          scoreHome: 2,
          scoreAway: 1,
        },
      ],
    }
    const s = orchestrator([p1], { store: { updateResult } })
    const res = await s.runResultsScan({ dates: ['2026-08-12'] })
    expect(res.updated).toBe(1)
    expect(updateResult).toHaveBeenCalledTimes(1)
    expect(updateResult.mock.calls[0][0]).toBe(
      getOrComputeMatchKey({
        homeTeam: 'FC Copenhagen',
        awayTeam: 'Debrecen',
        startTimestamp: 1755000000,
      })
    )
    expect(updateResult.mock.calls[0][1].status).toBe('finished')
  })

  it('runResultsScan skips providers without fetchResults', async () => {
    const updateResult = jest.fn(async () => 1)
    const p1 = { name: 'plain', priority: 1, fetch: async () => [] }
    const s = orchestrator([p1], { store: { updateResult } })
    const res = await s.runResultsScan({ dates: ['2026-08-12'] })
    expect(res.updated).toBe(0)
    expect(updateResult).not.toHaveBeenCalled()
  })

  it('runResultsScan tolerates a failing results provider', async () => {
    const updateResult = jest.fn(async () => 1)
    const p1 = {
      name: 'broken',
      priority: 1,
      fetch: async () => [],
      fetchResults: async () => { throw new Error('http: 500') },
    }
    const s = orchestrator([p1], { store: { updateResult } })
    const res = await s.runResultsScan({ dates: ['2026-08-12'] })
    expect(res.updated).toBe(0)
    expect(res.bySource.broken.error).toMatch(/500/)
  })
})
