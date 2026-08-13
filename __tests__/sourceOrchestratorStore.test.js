const db = require('../core/database')
const { createDefaultStore, backfillMatchKeys } = require('../services/sourceOrchestrator')

const TS = Math.floor(Date.UTC(2026, 7, 13, 18, 0, 0) / 1000)

function hasColumn(column) {
  const cols = db.prepare('PRAGMA table_info(matches)').all()
  return cols.some((c) => c.name === column)
}

describe('match_key migration (SQLite)', () => {
  it('adds the match_key column to the matches table', () => {
    expect(hasColumn('match_key')).toBe(true)
  })
})

describe('createDefaultStore', () => {
  const store = createDefaultStore()

  afterEach(() => {
    db.prepare('DELETE FROM matches WHERE id IN (?, ?, ?)').run('livescore_1', 'raw_null', 'livescore_2')
  })

  it('persists a new match and exposes it via getExistingKeys with a key', async () => {
    await store.persist(
      { id: 'livescore_1', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', league: 'LaLiga', source: 'livescore', startTimestamp: TS },
      'real madrid|barcelona|20260813'
    )
    const map = await store.getExistingKeys()
    expect(map.has('real madrid|barcelona|20260813')).toBe(true)
  })

  it('is idempotent: persisting the same match twice keeps one key', async () => {
    await store.persist(
      { id: 'livescore_1', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', league: 'LaLiga', source: 'livescore', startTimestamp: TS },
      'real madrid|barcelona|20260813'
    )
    await store.persist(
      { id: 'livescore_1', homeTeam: 'Real Madrid', awayTeam: 'Barcelona', league: 'LaLiga', source: 'livescore', startTimestamp: TS },
      'real madrid|barcelona|20260813'
    )
    const map = await store.getExistingKeys()
    expect(map.has('real madrid|barcelona|20260813')).toBe(true)
  })
})

describe('backfillMatchKeys', () => {
  const store = createDefaultStore()

  beforeEach(() => {
    db.prepare(
      'INSERT OR IGNORE INTO matches (id, homeTeam, awayTeam, league, startTimestamp, source, status, last_updated) VALUES (?,?,?,?,?,?,?,?)'
    ).run('raw_null', 'Ajax', 'PSV', 'Eredivisie', TS, 'livescore', 'scheduled', Date.now())
  })

  afterEach(() => {
    db.prepare('DELETE FROM matches WHERE id = ?').run('raw_null')
  })

  it('computes match_key for rows where it is NULL', async () => {
    const n = await backfillMatchKeys(store)
    expect(n).toBeGreaterThanOrEqual(1)
    const row = db.prepare('SELECT match_key FROM matches WHERE id = ?').get('raw_null')
    expect(row.match_key).toBeTruthy()
    expect(row.match_key).toContain('|20260813')
  })

  it('is idempotent: second run updates 0 rows', async () => {
    await backfillMatchKeys(store)
    const n2 = await backfillMatchKeys(store)
    expect(n2).toBe(0)
  })
})
