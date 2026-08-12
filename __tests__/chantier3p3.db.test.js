/**
 * Chantier 3 — POINT 3 : HONESTY GATE — écriture RÉELLE SQLite.
 * Valide database.persistOdds (colonne odds_fetch_error nouvellement migrée).
 * Aucun mock sur core/database ici (à l'inverse de chantier3p3.test.js).
 */

const database = require('../core/database')

describe('persistOdds — écriture réelle SQLite (colonne odds_fetch_error)', () => {
  const testId = 'c3p3_persist_' + Date.now()

  beforeEach(() => {
    try {
      database.db
        .prepare(
          `INSERT OR REPLACE INTO matches (id, homeTeam, awayTeam, league, status, timestamp, startTimestamp, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(testId, 'A', 'B', 'L', 'scheduled', Date.now(), Date.now(), 'test')
    } catch (e) {
      // colonnes manquantes => on laisse échouer les asserts (pas de skip dans ce suite)
    }
  })

  afterAll(() => {
    try {
      database.db.prepare('DELETE FROM matches WHERE id = ?').run(testId)
    } catch (_) {}
  })

  test('succès → odds_source=betexplorer, odds_fetch_error=null', () => {
    const ok = database.persistOdds(testId, {
      odds_home: 2.4,
      odds_draw: 3.1,
      odds_away: 3.5,
      odds_source: 'betexplorer',
      odds_fetch_error: null,
    })
    expect(ok).toBe(true)

    const row = database.db.prepare('SELECT * FROM matches WHERE id = ?').get(testId)
    expect(row.odds_home).toBe(2.4)
    expect(row.odds_draw).toBe(3.1)
    expect(row.odds_away).toBe(3.5)
    expect(row.odds_source).toBe('betexplorer')
    expect(row.odds_fetch_error).toBeNull()
  })

  test('échec → odds_source=null, odds_fetch_error=raison', () => {
    database.persistOdds(testId, {
      odds_source: null,
      odds_fetch_error: 'betexplorer:no_match',
    })

    const row = database.db.prepare('SELECT * FROM matches WHERE id = ?').get(testId)
    expect(row.odds_source).toBeNull()
    expect(row.odds_fetch_error).toBe('betexplorer:no_match')
  })

  test('réussite après échec → odds_fetch_error effacé (remis à null)', () => {
    database.persistOdds(testId, {
      odds_home: 2.1,
      odds_away: 3.3,
      odds_draw: 3.4,
      odds_source: 'betexplorer',
      odds_fetch_error: null,
    })

    const row = database.db.prepare('SELECT * FROM matches WHERE id = ?').get(testId)
    expect(row.odds_source).toBe('betexplorer')
    expect(row.odds_fetch_error).toBeNull()
  })
})