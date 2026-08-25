const plugin = require('../config/sources/livescore')
const { getOrComputeMatchKey } = require('../services/matchKey')

function fakeEvent({ eps = 'FT', tr1 = 2, tr2 = 1, trh1 = 1, trh2 = 0, esd = '20260812160000', eid = 99 } = {}) {
  return {
    Eid: eid,
    Eps: eps,
    Esd: esd,
    T1: [{ Nm: 'FC Copenhagen', ID: 1 }],
    T2: [{ Nm: 'Debrecen', ID: 2 }],
    Tr1: tr1,
    Tr2: tr2,
    Trh1: trh1,
    Trh2: trh2,
  }
}

const stage = { Snm: 'Qualification', CompD: 'UEFA', Cnm: 'Europe', CompN: 'UEFA Qualification', CompId: 123 }

describe('livescore plugin', () => {
  it('mapResult maps a FT event to a finished match with scores', () => {
    const r = plugin.mapResult(fakeEvent(), stage)
    expect(r.status).toBe('finished')
    expect(r.scoreHome).toBe(2)
    expect(r.scoreAway).toBe(1)
    expect(r.scoreHalfHome).toBe(1)
    expect(r.scoreHalfAway).toBe(0)
    expect(r.homeTeam).toBe('FC Copenhagen')
    expect(r.awayTeam).toBe('Debrecen')
  })

  it('mapResult produces the same match_key as the scheduled fixture', () => {
    const fixture = plugin.mapEvent(fakeEvent(), stage)
    const result = plugin.mapResult(fakeEvent(), stage)
    expect(getOrComputeMatchKey(fixture)).toBe(getOrComputeMatchKey(result))
  })

  it('mapResult ignores not-started events', () => {
    expect(plugin.mapResult(fakeEvent({ eps: 'NS' }), stage)).toBeNull()
  })

  it('mapResult returns null when scores are missing', () => {
    expect(plugin.mapResult(fakeEvent({ tr1: null, tr2: null }), stage)).toBeNull()
  })

  it('mapEvent stays a scheduled fixture with no score', () => {
    const f = plugin.mapEvent(fakeEvent(), stage)
    expect(f.status).toBe('scheduled')
    expect(f.scoreHome).toBeUndefined()
  })

  it('exports both fetch and fetchResults', () => {
    expect(typeof plugin.fetch).toBe('function')
    expect(typeof plugin.fetchResults).toBe('function')
  })
})
