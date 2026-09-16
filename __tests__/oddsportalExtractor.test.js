/**
 * E48 — oddsportalStatsExtractor : tests sans Chromium (client mocke) sur une
 * base SQLite in-memory. Couvre les 4 garanties contractuelles :
 *   (a) match avec cotes -> write + odds_source='oddsportal'
 *   (b) noOddsPublished (cotes '-') NE DOIT PAS compter comme erreur
 *   (c) match absent cote distant -> skippedNoMatch
 *   (d) COALESCE : une cote existante n'est JAMAIS ecrasee
 *   (e) selectRows : filtres ligue mappee / horizon / deja couvert
 */
const Database = require('better-sqlite3')
const extractor = require('../services/oddsportalStatsExtractor')

const NOW_MS = Date.now()
const NOW_S = Math.floor(NOW_MS / 1000)

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      "homeTeam" TEXT,
      "awayTeam" TEXT,
      league TEXT,
      category_name TEXT,
      status TEXT,
      "startTimestamp" INTEGER,
      odds_home REAL,
      odds_draw REAL,
      odds_away REAL,
      odds_over25 REAL,
      odds_under25 REAL,
      odds_source TEXT,
      last_updated INTEGER
    )
  `)
  return db
}

function insert(db, m) {
  db.prepare(
    `INSERT INTO matches (id,"homeTeam","awayTeam",league,category_name,status,"startTimestamp",
       odds_home,odds_draw,odds_away,odds_over25,odds_under25,odds_source,last_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(m.id),
    m.homeTeam,
    m.awayTeam,
    m.league,
    m.category_name || '',
    m.status || 'scheduled',
    m.startTimestamp,
    m.odds_home ?? null,
    m.odds_draw ?? null,
    m.odds_away ?? null,
    m.odds_over25 ?? null,
    m.odds_under25 ?? null,
    m.odds_source ?? null,
    null
  )
}

function mockClient(groupBySlug) {
  return {
    fetchLeagueOdds: jest.fn(async (slug) => groupBySlug[slug] || { slug, matches: [], noOddsPublished: 0, errors: 0, ms: 0 }),
    close: jest.fn(async () => {}),
    status: jest.fn(() => ({ running: false })),
  }
}

const NULL_LOG = { info: () => {}, warn: () => {}, debug: () => {} }

const HORIZON_TS = NOW_S + 6 * 3600

describe('oddsportalStatsExtractor (E48)', () => {
  describe('selectRows', () => {
    it('exclut ligues non mappees, matchs hors horizon et matchs deja couverts', () => {
      const db = makeDb()
      // mappee, dans l'horizon, sans cotes -> retenue
      insert(db, { id: 'keep', homeTeam: 'A', awayTeam: 'B', league: 'Serie D: Group D', startTimestamp: HORIZON_TS })
      // non mappee (Premier League absente du mapping obscur) -> exclue
      insert(db, { id: 'unmapped', homeTeam: 'C', awayTeam: 'D', league: 'Premier League', startTimestamp: HORIZON_TS })
      // mappee mais hors horizon 3j -> exclue
      insert(db, { id: 'far', homeTeam: 'E', awayTeam: 'F', league: 'Serie D: Group D', startTimestamp: NOW_S + 30 * 24 * 3600 })
      // mappee mais deja couverte par une source bookmaker -> exclue
      insert(db, {
        id: 'covered', homeTeam: 'G', awayTeam: 'H', league: 'Serie D: Group D', startTimestamp: HORIZON_TS,
        odds_home: 1.9, odds_draw: 3.3, odds_away: 4.0, odds_over25: 1.95, odds_under25: 1.85, odds_source: 'betexplorer',
      })
      const rows = extractor.selectRows(db, { limit: 20, horizonDays: 3 })
      expect(rows.map((r) => r.id)).toEqual(['keep'])
      db.close()
    })
  })

  describe('processScheduledMatches', () => {
    it('(a) match avec cotes -> write + odds_source=oddsportal', async () => {
      const db = makeDb()
      insert(db, { id: 'm1', homeTeam: 'Castellanzese', awayTeam: 'Oltrepo', league: 'Serie D: Group D', startTimestamp: HORIZON_TS })
      const client = mockClient({
        'italy/serie-d-group-d': {
          slug: 'italy/serie-d-group-d',
          noOddsPublished: 0,
          errors: 0,
          ms: 100,
          matches: [{ label: 'Castellanzese - Oltrepo', odds_home: 2.3, odds_draw: 2.98, odds_away: 2.96, odds_over25: 2.25, odds_under25: 1.6 }],
        },
      })
      const stats = await extractor.processScheduledMatches(db, { write: true, client, log: NULL_LOG, horizonDays: 3 })
      expect(stats.matched).toBe(1)
      expect(stats.written).toBe(1)
      expect(stats.errors).toBe(0)
      const row = db.prepare('SELECT * FROM matches WHERE id=?').get('m1')
      expect(row.odds_home).toBeCloseTo(2.3, 3)
      expect(row.odds_over25).toBeCloseTo(2.25, 3)
      expect(row.odds_source).toBe('oddsportal')
      db.close()
    })

    it('(b) noOddsPublished ne compte PAS comme erreur', async () => {
      const db = makeDb()
      insert(db, { id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'Serie D: Group A', startTimestamp: HORIZON_TS })
      const client = mockClient({
        'italy/serie-d-group-a': { slug: 'italy/serie-d-group-a', matches: [], noOddsPublished: 4, errors: 0, ms: 50 },
      })
      const stats = await extractor.processScheduledMatches(db, { write: true, client, log: NULL_LOG, horizonDays: 3 })
      expect(stats.noOddsPublished).toBe(4)
      expect(stats.errors).toBe(0)
      expect(stats.written).toBe(0)
      // le match est compte en skippedNoMatch (absent de res.matches) - normal
      expect(stats.skippedNoMatch).toBe(1)
      db.close()
    })

    it('(c) match absent de la reponse distante -> skippedNoMatch, pas errors', async () => {
      const db = makeDb()
      insert(db, { id: 'm1', homeTeam: 'Inconnu A', awayTeam: 'Inconnu B', league: 'Serie D: Group A', startTimestamp: HORIZON_TS })
      const client = mockClient({
        'italy/serie-d-group-a': {
          slug: 'italy/serie-d-group-a', noOddsPublished: 0, errors: 0, ms: 50,
          matches: [{ label: 'Autre Equipe - Autre Club', odds_home: 2.0, odds_draw: 3.0, odds_away: 3.5, odds_over25: 2.0, odds_under25: 1.8 }],
        },
      })
      const stats = await extractor.processScheduledMatches(db, { write: true, client, log: NULL_LOG, horizonDays: 3 })
      expect(stats.skippedNoMatch).toBe(1)
      expect(stats.errors).toBe(0)
      expect(stats.written).toBe(0)
      db.close()
    })

    it('(d) COALESCE : une cote existante n est JAMAIS ecrasee', async () => {
      const db = makeDb()
      insert(db, {
        id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'Serie D: Group D', startTimestamp: HORIZON_TS,
        odds_home: 1.5, odds_draw: null, odds_away: null,
      })
      const client = mockClient({
        'italy/serie-d-group-d': {
          slug: 'italy/serie-d-group-d', noOddsPublished: 0, errors: 0, ms: 50,
          matches: [{ label: 'A - B', odds_home: 1.9, odds_draw: 3.2, odds_away: 4.0, odds_over25: 2.0, odds_under25: 1.8 }],
        },
      })
      await extractor.processScheduledMatches(db, { write: true, client, log: NULL_LOG, horizonDays: 3 })
      const row = db.prepare('SELECT * FROM matches WHERE id=?').get('m1')
      expect(row.odds_home).toBeCloseTo(1.5, 3) // inchange
      expect(row.odds_draw).toBeCloseTo(3.2, 3) // comble (etait NULL)
      expect(row.odds_over25).toBeCloseTo(2.0, 3)
      db.close()
    })

    it('(e) dry-run : aucun write en base', async () => {
      const db = makeDb()
      insert(db, { id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'Serie D: Group D', startTimestamp: HORIZON_TS })
      const client = mockClient({
        'italy/serie-d-group-d': {
          slug: 'italy/serie-d-group-d', noOddsPublished: 0, errors: 0, ms: 50,
          matches: [{ label: 'A - B', odds_home: 1.9, odds_draw: 3.2, odds_away: 4.0, odds_over25: 2.0, odds_under25: 1.8 }],
        },
      })
      const stats = await extractor.processScheduledMatches(db, { write: false, client, log: NULL_LOG, horizonDays: 3 })
      expect(stats.dryRun).toBe(true)
      expect(stats.written).toBe(0)
      const row = db.prepare('SELECT * FROM matches WHERE id=?').get('m1')
      expect(row.odds_home).toBeNull()
      db.close()
    })
  })
})
