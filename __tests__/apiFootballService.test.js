const { mapStatus, mapEventToMatch, sortByPriority } = require('../services/apiFootballService')

describe('apiFootballService mapping', () => {
  it('maps scheduled + finished statuses correctly', () => {
    expect(mapStatus('NS')).toBe('scheduled')
    expect(mapStatus('TBD')).toBe('scheduled')
    expect(mapStatus('FT')).toBe('finished')
    expect(mapStatus('AET')).toBe('finished')
    expect(mapStatus('PEN')).toBe('finished')
    expect(mapStatus('CANC')).toBe('canceled')
    expect(mapStatus('POSTP')).toBe('postponed')
  })

  it('maps live periods (1H, 2H, ET) to inprogress', () => {
    expect(mapStatus('1H')).toBe('inprogress')
    expect(mapStatus('2H')).toBe('inprogress')
    expect(mapStatus('ET')).toBe('inprogress')
    expect(mapStatus('LIVE')).toBe('inprogress')
    expect(mapStatus('HT')).toBe('inprogress')
  })

  it('falls back to scheduled for unknown status', () => {
    expect(mapStatus('RANDOM_XYZ')).toBe('scheduled')
  })

  it('maps an event to a match with source apifootball', () => {
    const event = {
      fixture: { id: 123, timestamp: 1788547500, date: '2026-09-04T18:45:00+00:00' },
      league: { id: 39, name: 'Premier League', country: 'England' },
      teams: {
        home: { id: 50, name: 'Man City' },
        away: { id: 40, name: 'Liverpool' },
      },
      status: { short: 'NS' },
      goals: { home: null, away: null },
      score: { fulltime: { home: null, away: null } },
    }
    const m = mapEventToMatch(event)
    expect(m.id).toBe('apifb_123')
    expect(m.homeTeam).toBe('Man City')
    expect(m.awayTeam).toBe('Liverpool')
    expect(m.league).toBe('Premier League')
    expect(m.tournament_id).toBe(39)
    expect(m.status).toBe('scheduled')
    expect(m.source).toBe('apifootball')
  })

  it('prioritizes big-5 leagues first', () => {
    const big5 = {
      id: 'b1', tournament_id: 39,
      homeTeam: 'A', awayTeam: 'B', league: 'EPL', status: 'scheduled',
      category_name: '', tournament_name: '', timestamp: 'x',
    }
    const small = {
      id: 's1', tournament_id: 848,
      homeTeam: 'A', awayTeam: 'B', league: 'Small', status: 'scheduled',
      category_name: '', tournament_name: '', timestamp: 'x',
    }
    const sorted = sortByPriority([small, big5])
    expect(sorted[0].tournament_id).toBe(39)
  })
})
