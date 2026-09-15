/**
 * E37 — fotmobStatsExtractor (test OFFLINE : mock fotmobService, db memoire).
 * Verrouille : lien par (date+equipes normalisees), idempotence (COALESCE),
 * et le fait que le DRY-RUN n'ecrit RIEN (seul --write ecrit).
 */
process.env.FOTMOB_STATS_GAP_MS = '0'
const Database = require('better-sqlite3')

jest.mock('../services/fotmobService', () => ({
  getMatchesByDate: jest.fn(async () => [
    { id: '5795448', home: 'Coventry City', away: 'Brighton & Hove Albion', league: 'Premier League', status: 'FT' },
    { id: '9999999', home: 'Man Utd', away: 'Liverpool', league: 'Premier League', status: 'FT' },
  ]),
  getMatchStats: jest.fn(async (id) => {
    if (String(id) === '5795448')
      return { xg_home: 1.33, xg_away: 2.81, corners_home: 5, corners_away: 3, shots_home: 14, shots_away: 22, possession_home: 30, possession_away: 70 }
    return null
  }),
}))

const { processFinishedMatches, _clearDayMap } = require('../services/fotmobStatsExtractor')

function mkDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, timestamp TEXT, homeTeam TEXT, awayTeam TEXT,
      scoreHome INT, scoreAway INT, status TEXT, last_updated INT,
      fotmob_id TEXT, home_xg REAL, away_xg REAL,
      corners_home INT, corners_away INT, shots_home INT, shots_away INT,
      possession_home REAL, possession_away REAL
    )`)
  const ins = db.prepare(
    'INSERT INTO matches (id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, status, last_updated) VALUES (?,?,?,?,?,?,?,?)'
  )
  ins.run('livescore_1', '2026-09-13T20:00:00.000Z', 'Coventry City', 'Brighton & Hove Albion', 0, 5, 'finished', Date.now())
  ins.run('livescore_2', '2026-09-13T20:00:00.000Z', 'Man Utd', 'Liverpool', 1, 0, 'finished', Date.now())
  ins.run('livescore_3', '2026-09-13T20:00:00.000Z', 'Unknown FC', 'Ghost', 1, 0, 'finished', Date.now())
  return db
}

beforeEach(() => {
  _clearDayMap()
})

test('DRY-RUN ne doit RIEN ecrire', async () => {
  const db = mkDb()
  const s = await processFinishedMatches(db, { write: false })
  expect(s.scanned).toBe(3)
  expect(s.matched).toBe(1) // seul Coventry a des stats ; Man Utd mock null ; Unknown non mappe
  const row = db.prepare('SELECT home_xg, corners_home, fotmob_id FROM matches WHERE id = ?').get('livescore_1')
  expect(row.home_xg).toBeNull()
  expect(row.corners_home).toBeNull()
  expect(row.fotmob_id).toBeNull()
  db.close()
})

test("WRITE lie par date+equipes et n'ecrit que le match relie", async () => {
  const db = mkDb()
  const s = await processFinishedMatches(db, { write: true })
  const r1 = db.prepare('SELECT fotmob_id, home_xg, corners_home, shots_home FROM matches WHERE id = ?').get('livescore_1')
  expect(r1.fotmob_id).toBe('5795448')
  expect(r1.home_xg).toBeCloseTo(1.33)
  expect(r1.corners_home).toBe(5)
  expect(r1.shots_home).toBe(14)
  const r2 = db.prepare('SELECT home_xg FROM matches WHERE id = ?').get('livescore_2')
  expect(r2.home_xg).toBeNull() // stats null -> pas ecrit
  const r3 = db.prepare('SELECT fotmob_id FROM matches WHERE id = ?').get('livescore_3')
  expect(r3.fotmob_id).toBeNull() // pas dans la liste FotMob du jour
  expect(s.written).toBe(1)
  db.close()
})

test('IDEMPOTENT : deja avec xg/corners -> exclue du scan (pas de re-fetch ni ecrasement)', async () => {
  const db = mkDb()
  db.prepare('UPDATE matches SET home_xg = 9.9, corners_home = 42 WHERE id = ?').run('livescore_1')
  const s = await processFinishedMatches(db, { write: true })
  const r1 = db.prepare('SELECT home_xg, corners_home, fotmob_id FROM matches WHERE id = ?').get('livescore_1')
  expect(r1.home_xg).toBe(9.9) // non ecrase (exclu du WHERE)
  expect(r1.corners_home).toBe(42)
  expect(r1.fotmob_id).toBeNull() // pas re-ecrit non plus
  expect(s.scanned).toBe(2) // livescore_1 exclue
  expect(s.matched).toBe(0) // seul Coventry avait une stats ; Man Utd mock null ; Unknown non mappe
  db.close()
})
