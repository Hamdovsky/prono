/**
 * oddsSweeper Tests — sélection, budget, retry, persistance CLV, lock.
 */

const Database = require('better-sqlite3')
const sweeper = require('../services/oddsSweeper')
const { sweep, selectQueue, recordOddsHistory } = sweeper
const { _internal } = sweeper

function makeDb(rows = []) {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, homeTeam TEXT, awayTeam TEXT, league TEXT,
      status TEXT, startTimestamp INTEGER, category_name TEXT,
      odds_home REAL, odds_draw REAL, odds_away REAL,
      odds_over25 REAL, odds_under25 REAL,
      odds_btts_yes REAL, odds_btts_no REAL,
      odds_home_open REAL, odds_draw_open REAL, odds_away_open REAL,
      odds_source TEXT, last_updated INTEGER
    );
    CREATE TABLE odds_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT,
      minute INTEGER DEFAULT 0,
      odds_home REAL, odds_draw REAL, odds_away REAL,
      type TEXT DEFAULT 'LIVE', timestamp BIGINT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const ins = db.prepare(
    `INSERT INTO matches (id, homeTeam, awayTeam, league, status, startTimestamp, category_name,
       odds_home, odds_draw, odds_away, odds_over25, odds_under25,
       odds_btts_yes, odds_btts_no, odds_home_open, odds_draw_open, odds_away_open)
     VALUES (@id, @homeTeam, @awayTeam, @league, @status, @startTimestamp, @category_name,
       @odds_home, @odds_draw, @odds_away, @odds_over25, @odds_under25,
       @odds_btts_yes, @odds_btts_no, @odds_home_open, @odds_draw_open, @odds_away_open)`
  )
  for (const r of rows) {
    ins.run({
      league: r.league ?? 'Ligue',
      odds_home: r.odds_home ?? null,
      odds_draw: r.odds_draw ?? null,
      odds_away: r.odds_away ?? null,
      odds_over25: r.odds_over25 ?? null,
      odds_under25: r.odds_under25 ?? null,
      odds_btts_yes: r.odds_btts_yes ?? null,
      odds_btts_no: r.odds_btts_no ?? null,
      odds_home_open: r.odds_home_open ?? null,
      odds_draw_open: r.odds_draw_open ?? null,
      odds_away_open: r.odds_away_open ?? null,
      category_name: r.category_name ?? 'League',
      ...r,
    })
  }
  return db
}

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000

function sec(ts) {
  return Math.floor(ts / 1000)
}

const FULL = { odds_home: 2.0, odds_draw: 3.2, odds_away: 3.5, odds_over25: 1.7, odds_under25: 2.1, odds_btts_yes: 1.8, odds_btts_no: 1.9 }

beforeEach(() => {
  _internal.__resetAttempts()
  _internal.__setRunning(false)
})

describe('helpers', () => {
  test('hasFull1x2 exige les 3 cotes > 1', () => {
    expect(_internal.hasFull1x2({ odds_home: 2, odds_draw: 3, odds_away: 4 })).toBe(true)
    expect(_internal.hasFull1x2({ odds_home: 2, odds_draw: null, odds_away: 4 })).toBe(false)
    expect(_internal.hasFull1x2({})).toBe(false)
  })

  test('needsWork = faux quand 1X2 + O2.5 + BTTS complets', () => {
    expect(_internal.needsWork(FULL)).toBe(false)
    expect(_internal.needsWork({ ...FULL, odds_over25: null })).toBe(true)
    expect(_internal.needsWork({ ...FULL, odds_btts_yes: null })).toBe(true)
    expect(_internal.needsWork({})).toBe(true)
  })
})

describe('selectQueue', () => {
  test('filtre horizon/statut, priorité aux matchs sans 1X2, tri par kickoff', () => {
    const now = Date.now()
    const db = makeDb([
      { id: 'm-full', homeTeam: 'A', awayTeam: 'B', status: 'scheduled', startTimestamp: sec(now + HOUR), ...FULL },
      { id: 'm-no1x2', homeTeam: 'C', awayTeam: 'D', status: 'scheduled', startTimestamp: sec(now + HOUR), odds_over25: 1.7 },
      { id: 'm-ou-manquant', homeTeam: 'E', awayTeam: 'F', status: 'scheduled', startTimestamp: sec(now + 2 * HOUR), odds_home: 2, odds_draw: 3, odds_away: 4 },
      { id: 'm-horizon', homeTeam: 'G', awayTeam: 'H', status: 'scheduled', startTimestamp: sec(now + 5 * DAY) },
      { id: 'm-ft', homeTeam: 'I', awayTeam: 'J', status: 'FT', startTimestamp: sec(now + HOUR) },
    ])

    const out = selectQueue({ db, horizonDays: 3 })
    const ids = out.queue.map((m) => m.id)
    expect(ids).toContain('m-no1x2')
    expect(ids).toContain('m-ou-manquant')
    expect(ids).not.toContain('m-full')
    expect(ids).not.toContain('m-horizon')
    expect(ids).not.toContain('m-ft')
    // 1X2 manquant en premier
    expect(ids[0]).toBe('m-no1x2')
    // compteurs (m-ft exclu de la requête : statut hors STATUSES)
    expect(out.scanned).toBe(4)
    expect(out.with1x2).toBe(2) // m-full + m-ou-manquant
  })

  test('les ligues MENA ne sont plus filtrées (Botola, Saudi Pro, Egyptian, etc.)', () => {
    const now = Date.now()
    const db = makeDb([
      { id: 'm-saudi', homeTeam: 'Al-Hilal', awayTeam: 'Al-Ittihad', league: 'Saudi Pro', status: 'scheduled', startTimestamp: sec(now + HOUR) },
      { id: 'm-botola', homeTeam: 'Wydad', awayTeam: 'Raja', league: 'Botola', status: 'scheduled', startTimestamp: sec(now + 2 * HOUR) },
      { id: 'm-egypt', homeTeam: 'Al Ahly', awayTeam: 'Zamalek', league: 'Egyptian Premier', status: 'scheduled', startTimestamp: sec(now + 3 * HOUR) },
      { id: 'm-uae', homeTeam: 'Al Jazira', awayTeam: 'Al Wasl', league: 'UAE Pro League', status: 'scheduled', startTimestamp: sec(now + 4 * HOUR) },
    ])
    const out = selectQueue({ db, horizonDays: 7 })
    const ids = out.queue.map((m) => m.id)
    expect(ids).toContain('m-saudi')
    expect(ids).toContain('m-botola')
    expect(ids).toContain('m-egypt')
    expect(ids).toContain('m-uae')
    expect(out.scanned).toBe(4)
  })
})

describe('recordOddsHistory', () => {
  test('insère la ligne LIVE quand les 3 cotes 1X2 sont présentes', () => {
    const db = makeDb()
    recordOddsHistory('m1', { home: 2.0, draw: 3.2, away: 3.5 }, { db })
    const rows = db.prepare('SELECT * FROM odds_history').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].match_id).toBe('m1')
    expect(rows[0].odds_home).toBe(2.0)
    expect(rows[0].type).toBe('LIVE')
  })

  test("n'insère rien si le marché 1X2 est incomplet (ex. O/U seul)", () => {
    const db = makeDb()
    recordOddsHistory('m1', { over25: 1.7 }, { db })
    expect(db.prepare('SELECT COUNT(*) c FROM odds_history').get().c).toBe(0)
  })
})

describe('sweep (orchestration)', () => {
  test('budget court -> arrêt anticipé', async () => {
    const now = Date.now()
    const db = makeDb([
      { id: 'm1', homeTeam: 'A', awayTeam: 'B', status: 'scheduled', startTimestamp: sec(now + HOUR) },
      { id: 'm2', homeTeam: 'C', awayTeam: 'D', status: 'scheduled', startTimestamp: sec(now + 2 * HOUR) },
    ])
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const fetchOdds = async () => {
      await sleep(8)
      return null
    }
    const res = await sweep({ skipLock: true, db, fetchOdds, budgetMs: 5, limit: 0 })
    expect(res.stats.budget).toBe(true)
    expect(res.stats.scanned).toBe(1)
  }, 10000)

  test('retry : un match échoué est sauté tant que retryMs pas écoulé', async () => {
    const now = Date.now()
    const db = makeDb([{ id: 'm1', homeTeam: 'A', awayTeam: 'B', status: 'scheduled', startTimestamp: sec(now + HOUR) }])
    const fetchOdds = () => null
    await sweep({ skipLock: true, db, fetchOdds, retryMs: 60000, limit: 0 })
    const res2 = await sweep({ skipLock: true, db, fetchOdds, retryMs: 60000, limit: 0 })
    expect(res2.stats.skipped).toBe(1)
    expect(res2.stats.failed).toBe(0)
  }, 10000)

  test('limit borne le nombre de matchs traités', async () => {
    const now = Date.now()
    const db = makeDb([
      { id: 'm1', homeTeam: 'A', awayTeam: 'B', status: 'scheduled', startTimestamp: sec(now + HOUR) },
      { id: 'm2', homeTeam: 'C', awayTeam: 'D', status: 'scheduled', startTimestamp: sec(now + 2 * HOUR) },
    ])
    const fetchOdds = () => ({ home: 2.0, draw: 3.2, away: 3.5 })
    const res = await sweep({ skipLock: true, db, fetchOdds, limit: 1, retryMs: 0 })
    expect(res.stats.fetched).toBe(1)
    expect(res.stats.scanned).toBe(1)
  }, 10000)

  test('passe complète : succès + coverage + pas de lock', async () => {
    const now = Date.now()
    const db = makeDb([
      { id: 'm1', homeTeam: 'A', awayTeam: 'B', status: 'scheduled', startTimestamp: sec(now + HOUR), odds_home: null },
      { id: 'm2', homeTeam: 'C', awayTeam: 'D', status: 'scheduled', startTimestamp: sec(now + HOUR), odds_home: 2, odds_draw: 3, odds_away: 4, odds_over25: null },
    ])
    const fetchOdds = () => ({ home: 2.4, draw: 3.1, away: 2.9, over25: 1.75, under25: 2.0, btts_yes: 1.8, btts_no: 1.9, source: 'betexplorer' })
    const res = await sweep({ skipLock: true, db, fetchOdds, horizonDays: 3, budgetMs: 20000, limit: 0, retryMs: 0 })
    expect(res.success).toBe(true)
    expect(res.stats.fetched).toBe(2)
    expect(res.stats.failed).toBe(0)
    expect(res.stats.coverage.with1x2).toBe(2)
    // odds_history rempli + odds_home_open persisté sur le 1er match
    const hist = db.prepare('SELECT COUNT(*) c FROM odds_history').get().c
    expect(hist).toBe(2)
    const open = db.prepare('SELECT odds_home_open FROM matches WHERE id = ?').get('m1')
    expect(open.odds_home_open).toBe(2.4)
  }, 15000)

  test('déjà en cours -> locked', async () => {
    _internal.__setRunning(true)
    const res = await sweep({ skipLock: true })
    expect(res.locked).toBe(true)
    expect(res.running).toBe(true)
    _internal.__setRunning(false)
  })
})
