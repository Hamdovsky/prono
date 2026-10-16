const { mapStatus, mapEventToMatch, sortByPriority, ALL_LEAGUES, MENA_LEAGUES, AFRICA_LEAGUES, D2_LEAGUES } = require('../services/apiFootballService')

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

describe('apiFootballService leagues E117 (verifies API-Sports)', () => {
  it('couvre Tunisie, Algerie, Maroc, Egypte, Afrique du Sud + D2', () => {
    for (const id of [202, 828, 186, 187, 200, 201, 233, 887, 288, 289, 136, 141]) {
      expect(ALL_LEAGUES).toContain(id)
    }
    expect(MENA_LEAGUES).toEqual(expect.arrayContaining([202, 186, 200, 233]))
    expect(AFRICA_LEAGUES).toEqual(expect.arrayContaining([288, 289]))
    expect(D2_LEAGUES).toEqual(expect.arrayContaining([136, 141]))
  })

  it('Egypte = 233, pas 203 (Turquie) ; IDs morts exclus', () => {
    // 203 = Super Lig turque (etait mappee Egypte par erreur),
    // 3831 = ID inexistant, 1243 = foot feminin SA (etait mappe Syrie).
    expect(ALL_LEAGUES).not.toContain(203)
    expect(ALL_LEAGUES).not.toContain(3831)
    expect(ALL_LEAGUES).not.toContain(1243)
  })

  it('aucun doublon entre groupes', () => {
    const set = new Set(ALL_LEAGUES)
    expect(set.size).toBe(ALL_LEAGUES.length)
  })

  it('un match de ligue faible arrive PENDING + insufficient_data', () => {
    const { mapEventToMatch: map } = require('../services/apiFootballService')
    const event = {
      fixture: { id: 999, timestamp: 1788547500, date: '2026-09-04T18:45:00+00:00' },
      league: { id: 202, name: 'Ligue 1', country: 'Tunisia' },
      teams: { home: { id: 1, name: 'EST' }, away: { id: 2, name: 'ESS' } },
      status: { short: 'NS' },
      goals: { home: null, away: null },
      score: { fulltime: { home: null, away: null } },
    }
    const m = map(event)
    expect(m.verdict).toBe('PENDING')
    expect(m.insufficient_data).toBe(1)
    expect(m.prediction).toBeNull()
  })
})
