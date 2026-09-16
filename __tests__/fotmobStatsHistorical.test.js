/**
 * E57 — passe historique de fotmobStatsExtractor.
 * Les matchs termines vivent dans historical_matches (l'archivage les supprime de
 * `matches` : course E56). Verrouille que la passe ecrit home_xg DANS le fullData
 * (cle home_xg, pas xg_home) sans ecraser l'existant, et qu'elle est tolerante si
 * la table historique est absente (DB `matches` seule).
 */
process.env.FOTMOB_STATS_GAP_MS = '0'
const Database = require('better-sqlite3')

jest.mock('../services/fotmobService', () => ({
  getMatchesByDate: jest.fn(async () => [
    { id: '777', home: 'Coventry City', away: 'Brighton & Hove Albion', league: 'PL', status: 'FT' },
  ]),
  getMatchStats: jest.fn(async (id) => {
    if (String(id) === '777')
      return { xg_home: 1.33, xg_away: 2.81, corners_home: 5, corners_away: 3 }
    return null
  }),
}))

const { _processHistorical, _clearDayMap } = require('../services/fotmobStatsExtractor')

function mkDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE historical_matches (
      id TEXT PRIMARY KEY, timestamp TEXT, homeTeam TEXT, awayTeam TEXT,
      scoreHome INT, scoreAway INT, fullData TEXT
    )`)
  const ins = db.prepare(
    'INSERT INTO historical_matches (id, timestamp, homeTeam, awayTeam, scoreHome, scoreAway, fullData) VALUES (?,?,?,?,?,?,?)'
  )
  ins.run('h1', '2026-09-13T20:00:00.000Z', 'Coventry City', 'Brighton & Hove Albion', 0, 5, '{}')
  ins.run('h2', '2026-09-13T20:00:00.000Z', 'Ghost FC', 'Nobody', 1, 0, '{}')
  return db
}

beforeEach(() => _clearDayMap())

test('DRY-RUN historique : matche sans ecrire', async () => {
  const db = mkDb()
  const s = await _processHistorical(db, { write: false })
  expect(s.scanned).toBe(2)
  expect(s.matched).toBe(1) // seul Coventry est mappe + a des stats
  expect(s.written).toBe(0)
  const fd = JSON.parse(db.prepare('SELECT fullData FROM historical_matches WHERE id=?').get('h1').fullData)
  expect(fd.home_xg).toBeUndefined()
  db.close()
})

test('WRITE historique : home_xg ecrit dans fullData (cles home_xg/away_xg)', async () => {
  const db = mkDb()
  const s = await _processHistorical(db, { write: true })
  expect(s.matched).toBe(1)
  expect(s.written).toBe(1)
  const fd = JSON.parse(db.prepare('SELECT fullData FROM historical_matches WHERE id=?').get('h1').fullData)
  expect(fd.home_xg).toBeCloseTo(1.33)
  expect(fd.away_xg).toBeCloseTo(2.81)
  expect(fd.fotmob_id).toBe('777')
  expect(fd.xg_home).toBeUndefined() // pas de cle parasite
  db.close()
})

test('IDEMPOTENT : deja avec home_xg -> exclu du scan', async () => {
  const db = mkDb()
  db.prepare('UPDATE historical_matches SET fullData=? WHERE id=?').run(JSON.stringify({ home_xg: 9.9 }), 'h1')
  const s = await _processHistorical(db, { write: true })
  expect(s.scanned).toBe(1) // h1 exclue
  const fd = JSON.parse(db.prepare('SELECT fullData FROM historical_matches WHERE id=?').get('h1').fullData)
  expect(fd.home_xg).toBe(9.9) // non ecrase
  db.close()
})

test('TOLERANT : table historical absente -> 0, pas de throw', async () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE matches (id TEXT)')
  const s = await _processHistorical(db, { write: true })
  expect(s.scanned).toBe(0)
  db.close()
})
