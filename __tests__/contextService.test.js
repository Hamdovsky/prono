/**
 * Tests contextService.js — assemblage ctx_v1 (agrégation seule, pas de CAC)
 */
const { buildMatchContext, motivationLabel, normalizeAbsences } = require('../services/contextService')

const TS = 1789200000 // secondes

const mkMatch = (over = {}) => ({
  id: 'ev1',
  homeTeam: 'Home FC',
  awayTeam: 'Away SC',
  startTimestamp: TS,
  league: 'Premier Division',
  ...over,
})

describe('buildMatchContext', () => {
  it('détecte une échéance européenne à J+3 (stage group)', async () => {
    const db = {
      getUpcomingFixturesByTeam: async () => [
        { league: 'UEFA Champions League: League Phase', ts: TS + 3 * 86400 },
      ],
      getHoursRest: async () => 70,
    }
    const ctx = await buildMatchContext(mkMatch(), null, db)
    expect(ctx.schema).toBe('ctx_v1')
    expect(ctx.teams.home.european_next).toEqual({ comp: 'UCL', stage: 'group', gap_days: 3 })
    expect(ctx.teams.away.european_next).not.toBeNull()
    expect(ctx.teams.home.rest_hours).toBe(70)
    expect(ctx.teams.home.injury_impact).toBeNull()
  })

  it('knockout détecté sur quarts de finale', async () => {
    const db = {
      getUpcomingFixturesByTeam: async () => [
        { league: 'UEFA Europa League: Quarter-finals', ts: TS + 86400 * 2 },
      ],
      getHoursRest: async () => null,
    }
    const ctx = await buildMatchContext(mkMatch(), null, db)
    expect(ctx.teams.home.european_next).toEqual({ comp: 'UEL', stage: 'knockout', gap_days: 2 })
  })

  it('fixture hors fenêtre ignorée (ts <= +12h)', async () => {
    const db = {
      getUpcomingFixturesByTeam: async () => [{ league: 'Champions League', ts: TS + 600 }],
      getHoursRest: async () => null,
    }
    const ctx = await buildMatchContext(mkMatch(), null, db)
    expect(ctx.teams.home.european_next).toBeNull()
  })

  it('ligue nationale -> european_next null', async () => {
    const db = {
      getUpcomingFixturesByTeam: async () => [{ league: 'Serie A', ts: TS + 4 * 86400 }],
      getHoursRest: async () => 90,
    }
    const ctx = await buildMatchContext(mkMatch(), null, db)
    expect(ctx.teams.home.european_next).toBeNull()
    expect(ctx.teams.home.rest_hours).toBe(90)
  })

  it('absence de DAO (mode PG) ne casse rien', async () => {
    const ctx = await buildMatchContext(mkMatch(), null, {})
    expect(ctx.teams.home).toEqual({
      absences: [],
      injury_impact: null,
      european_next: null,
      rest_hours: null,
      motivation: 'STANDARD',
    })
  })

  it('absences normalisées depuis newsIntel (objets et chaînes)', async () => {
    const newsIntel = {
      home: { injuries: [{ player: 'GK1', position: 'Goalkeeper', status: 'injury' }, 'STR2'] },
      away: { injuries: null },
    }
    const ctx = await buildMatchContext(mkMatch(), newsIntel, {})
    expect(ctx.teams.home.absences).toHaveLength(2)
    expect(ctx.teams.home.absences[1]).toEqual({ player: 'STR2', position: '', status: 'unavailable' })
    expect(ctx.teams.away.absences).toEqual([])
  })

  it('startTimestamp manquant -> null', async () => {
    const ctx = await buildMatchContext({ homeTeam: 'A', awayTeam: 'B' }, null, {})
    expect(ctx).toBeNull()
  })

  it('timestamp en ms normalisé en secondes', async () => {
    const db = {
      getUpcomingFixturesByTeam: async (name, from, to) => {
        expect(from).toBeGreaterThan(1e9)
        expect(from).toBeLessThan(1e11)
        return []
      },
      getHoursRest: async (name, t) => {
        expect(t).toBeLessThan(1e11)
        return null
      },
    }
    await buildMatchContext(mkMatch({ startTimestamp: TS * 1000 }), null, db)
  })
})

describe('motivationLabel', () => {
  it('cartographie zones DMF -> labels ctx', () => {
    expect(motivationLabel({ home_zone: 'Battle Zone (Title)' }, 'home')).toBe('TITLE')
    expect(motivationLabel({ away_zone: 'Battle Zone (Relegation)' }, 'away')).toBe('RELEGATION')
    expect(motivationLabel({ home_zone: 'Battle Zone (Europe)' }, 'home')).toBe('EUROPE_RACE')
    expect(motivationLabel({ home_zone: 'Dead Zone' }, 'home')).toBe('DEAD_RUBBER')
    expect(motivationLabel({ league: 'Club Friendly' }, 'home')).toBe('FRIENDLY')
    expect(motivationLabel({}, 'home')).toBe('STANDARD')
  })
})

describe('normalizeAbsences', () => {
  it('plafonne à 12 et vide les entrées sans nom', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ player: `P${i}` }))
    expect(normalizeAbsences(many)).toHaveLength(12)
    expect(normalizeAbsences([{ position: 'GK' }, { player: 'X' }])).toHaveLength(1)
    expect(normalizeAbsences(undefined)).toEqual([])
  })
})
