/**
 * Sofascore Day Collector (E85) — offline.
 *
 *  - matching fixtures Sofascore -> matchs de la base (noms d'équipes tolérants)
 *  - parsing des payloads /featured bruts via parseFeaturedOdds & consorts
 *  - collect() : trace sur disque + retour de la liste voulue
 *  - ingest()  : ecriture via database.persistOdds (odds_source = 'sofascore')
 *
 * core/database est mocké : aucun ecrit SQLite ici.
 */
const fs = require('fs')

jest.mock('../core/database', () => ({
  getMatchesByDate: jest.fn(async () => []),
  getMatchesStartingSoon: jest.fn(async () => []),
  persistOdds: jest.fn(() => true),
  getMatchById: jest.fn(),
}))

const database = require('../core/database')
const collector = require('../services/sofascoreDayCollector')

const DAY = '2026-10-08'

// NOTE : __tests__/setup.js mock globalement fs (writeFileSync = no-op,
// readFileSync = '{}') pour qu'aucun test ne touche aux données de prod.
// La trace disque se vérifie donc sur l'appel à fs.writeFileSync, pas sur
// le contenu réel du fichier.

beforeEach(() => {
  jest.clearAllMocks()
  database.getMatchesByDate.mockResolvedValue([])
  database.persistOdds.mockReturnValue(true)
})

// ── Matching noms d'équipes ────────────────────────────────────────────────
describe('fixturesMatch — noms d’équipes tolérants', () => {
  test('accents + préfixe de club ignorés', () => {
    const fx = { homeTeam: 'Club Atlético Chacarita Juniors', awayTeam: 'CA Patronato' }
    const db = { homeTeam: 'Chacarita Juniors', awayTeam: 'Patronato' }
    expect(collector.fixturesMatch(fx, db)).toBe(true)
  })

  test('préfixe FC ajouté par Sofascore', () => {
    expect(
      collector.fixturesMatch(
        { homeTeam: 'FC Tampa Bay Rowdies', awayTeam: 'Miami FC' },
        { homeTeam: 'Tampa Bay Rowdies', awayTeam: 'Miami' }
      )
    ).toBe(true)
  })

  test('équipe réelle d’une ligue anglaise mineure', () => {
    expect(
      collector.fixturesMatch(
        { homeTeam: 'Grays Athletic', awayTeam: 'Witham Town' },
        { homeTeam: 'Grays Athletic', awayTeam: 'Witham Town' }
      )
    ).toBe(true)
  })

  test('matchs différents -> pas d’appariement', () => {
    expect(
      collector.fixturesMatch(
        { homeTeam: 'Grays Athletic', awayTeam: 'Witham Town' },
        { homeTeam: 'Brentwood Town', awayTeam: 'Witham Town' }
      )
    ).toBe(false)
  })

  test('journée retour (ordre inversé) appariée', () => {
    expect(
      collector.fixturesMatch(
        { homeTeam: 'Patronato', awayTeam: 'Chacarita Juniors' },
        { homeTeam: 'Chacarita Juniors', awayTeam: 'Patronato' }
      )
    ).toBe(true)
  })
})

// ── Parsing des payloads bruts (réutilise les parseurs du service) ────────
describe('parseMarkets — payloads /featured bruts', () => {
  const M1 = {
    featured: {
      default: {
        choices: [
          { name: '1', fractionalValue: '17/20' },
          { name: 'X', fractionalValue: '11/4' },
          { name: '2', fractionalValue: '11/5' },
        ],
      },
    },
  }
  const M5 = {
    featured: {
      default: {
        choices: [
          { name: 'Over 2.5', decimalValue: 1.9 },
          { name: 'Under 2.5', decimalValue: 1.9 },
        ],
      },
    },
  }
  const M6 = {
    featured: {
      default: {
        choices: [
          { name: 'Yes', decimalValue: 1.8 },
          { name: 'No', decimalValue: 1.95 },
        ],
      },
    },
  }

  test('1X2 en fractions converties en décimal', () => {
    const odds = collector.parseMarkets({ m1: M1 })
    expect(odds.home).toBeCloseTo(1.85, 5)
    expect(odds.draw).toBeCloseTo(3.75, 5)
    expect(odds.away).toBeCloseTo(3.2, 5)
  })

  test('O/U 2.5 + BTTS récupérés quand présents', () => {
    const odds = collector.parseMarkets({ m1: M1, m5: M5, m6: M6 })
    expect(odds.over25).toBeCloseTo(1.9, 5)
    expect(odds.under25).toBeCloseTo(1.9, 5)
    expect(odds.bttsYes).toBeCloseTo(1.8, 5)
    expect(odds.bttsNo).toBeCloseTo(1.95, 5)
  })

  test('marché 5/6 absents (404 Sofascore) -> pas d’erreur, 1X2 seul', () => {
    const odds = collector.parseMarkets({ m1: M1 })
    expect(odds.over25).toBeUndefined()
    expect(odds.bttsYes).toBeUndefined()
    expect(odds.home).toBeCloseTo(1.85, 5)
  })

  test('payload vide -> objet vide (le garde noOdds prend le relais)', () => {
    expect(collector.parseMarkets({})).toEqual({})
    expect(collector.parseMarkets(null)).toEqual({})
  })
})

// ── Phase 1 : collect ──────────────────────────────────────────────────────
describe('collect', () => {
  const DB = [
    { id: 'livescore_1', homeTeam: 'Chacarita Juniors', awayTeam: 'Patronato', league: 'Primera Nacional' },
    { id: 'livescore_2', homeTeam: 'Tampa Bay Rowdies', awayTeam: 'Miami FC', league: 'USL Championship' },
  ]

  test('retourne uniquement les fixtures présentes en base', async () => {
    database.getMatchesByDate.mockResolvedValue(DB)
    const res = await collector.collect(DAY, [
      { eventId: 111, homeTeam: 'Club Atlético Chacarita Juniors', awayTeam: 'CA Patronato' },
      { eventId: 222, homeTeam: 'Grays Athletic', awayTeam: 'Witham Town' },
      { eventId: 333, homeTeam: 'FC Tampa Bay Rowdies', awayTeam: 'Miami FC' },
    ])
    expect(res.matched).toBe(2)
    expect(res.unmatched).toBe(1)
    expect(res.wanted.map((w) => w.eventId).sort()).toEqual([111, 333])
    expect(res.wanted.find((w) => w.eventId === 111).matchId).toBe('livescore_1')
    expect(res.wanted.find((w) => w.eventId === 333).matchId).toBe('livescore_2')
  })

  test('les fixtures de la journée sont tracées (fs.writeFileSync)', async () => {
    const res = await collector.collect(DAY, [
      { eventId: 111, homeTeam: 'Chacarita Juniors', awayTeam: 'Patronato' },
    ])
    expect(res.saved).toBe(true)

    const call = (fs.writeFileSync.mock.calls || []).find((c) =>
      String(c[0]).includes(`sofascore_fixtures_${DAY}.json`)
    )
    expect(call).toBeTruthy()
    const payload = JSON.parse(call[1])
    expect(payload.day).toBe(DAY)
    expect(payload.count).toBe(1)
    expect(payload.fixtures[0].eventId).toBe(111)
    expect(payload.savedAt).toBeTruthy()
  })

  test('aucune fixture valide -> 0 voulu, pas d’exception', async () => {
    const res = await collector.collect(DAY, [{ eventId: null }, null])
    expect(res.matched).toBe(0)
    expect(res.wanted).toEqual([])
  })
})

// ── Phase 3 : ingest ───────────────────────────────────────────────────────
describe('ingest', () => {
  test('ecrit via persistOdds avec odds_source = sofascore', async () => {
    const res = await collector.ingest(DAY, [
      {
        eventId: 111,
        matchId: 'livescore_1',
        homeTeam: 'Chacarita Juniors',
        awayTeam: 'Patronato',
        odds: { home: 1.85, draw: 3.75, away: 3.2, over25: 1.9, under25: 1.9, bttsYes: 1.8, bttsNo: 1.95 },
      },
    ])
    expect(res.persisted).toBe(1)
    expect(database.persistOdds).toHaveBeenCalledWith(
      'livescore_1',
      expect.objectContaining({
        odds_home: 1.85,
        odds_draw: 3.75,
        odds_away: 3.2,
        odds_over25: 1.9,
        odds_btts_yes: 1.8,
        odds_source: 'sofascore',
        odds_fetch_error: null,
      })
    )
  })

  test('payload brut m1 parsé côté serveur avant écriture', async () => {
    const M1 = {
      featured: {
        default: {
          choices: [
            { name: '1', fractionalValue: '1/1' },
            { name: 'X', fractionalValue: '5/2' },
            { name: '2', fractionalValue: '9/2' },
          ],
        },
      },
    }
    const res = await collector.ingest(DAY, [
      { eventId: 111, matchId: 'livescore_1', markets: { m1: M1 } },
    ])
    expect(res.persisted).toBe(1)
    expect(database.persistOdds).toHaveBeenCalledWith(
      'livescore_1',
      expect.objectContaining({ odds_home: 2, odds_draw: 3.5, odds_away: 5.5 })
    )
  })

  test('cote incomplète -> noOdds, aucune écriture', async () => {
    const res = await collector.ingest(DAY, [
      { eventId: 111, matchId: 'livescore_1', odds: { home: 1.8 } },
    ])
    expect(res.noOdds).toBe(1)
    expect(res.persisted).toBe(0)
    expect(database.persistOdds).not.toHaveBeenCalled()
  })

  test('matchId absent -> recherche par noms puis écriture', async () => {
    database.getMatchesByDate.mockResolvedValue([
      { id: 'livescore_9', homeTeam: 'Grays Athletic', awayTeam: 'Witham Town' },
    ])
    const res = await collector.ingest(DAY, [
      { eventId: 444, homeTeam: 'Grays Athletic', awayTeam: 'Witham Town', odds: { home: 2.1, draw: 3.4, away: 3.5 } },
    ])
    expect(res.persisted).toBe(1)
    expect(database.persistOdds).toHaveBeenCalledWith('livescore_9', expect.anything())
  })

  test('match inconnu -> unknown, aucune écriture', async () => {
    database.getMatchesByDate.mockResolvedValue([])
    const res = await collector.ingest(DAY, [
      { eventId: 444, homeTeam: 'Inconnu Total', awayTeam: 'Autre Club', odds: { home: 2.1, draw: 3.4, away: 3.5 } },
    ])
    expect(res.unknown).toBe(1)
    expect(database.persistOdds).not.toHaveBeenCalled()
  })

  test('aucune ligne -> compteurs à zéro', async () => {
    const res = await collector.ingest(DAY, [])
    expect(res).toMatchObject({ received: 0, persisted: 0, unknown: 0, noOdds: 0 })
  })
})
