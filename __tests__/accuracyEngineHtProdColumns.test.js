/**
 * Regression HT (E23) — l'engine doit lire le score de 1re mi-temps sous les
 * NOMS REELS de la base de production (`ht_score_home` / `ht_score_away`, colonne
 * OU `fullData`), pas `score_home_ht` (nom qui n'existe QUE dans le fixture du
 * test accuracyEngine.test.js -> faux-positif historique qui masquait le bug :
 * les ~5106 picks HT archives etaient mesures 0). Sans repli `fd.*`, une future
 * recodification du nom ferait retomber HT a 0.
 */
const Database = require('better-sqlite3')
const { computeAccuracy } = require('../services/accuracyEngine')

function prodDb() {
  const db = new Database(':memory:')
  // Schéma = noms de COLONNES de la vraie base (ht_score_home, pas score_home_ht).
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY, league TEXT, scoreHome INTEGER, scoreAway INTEGER,
      status TEXT, prediction TEXT, confidence REAL, fullData TEXT,
      ht_score_home INTEGER, ht_score_away INTEGER, timestamp TEXT, startTimestamp INTEGER
    );
    CREATE TABLE historical_matches (
      id TEXT PRIMARY KEY, league TEXT, scoreHome INTEGER, scoreAway INTEGER,
      fullData TEXT, timestamp TEXT, archived_at TEXT
    );
  `)
  return db
}

test('matches : pick HT lu quand le score MT est dans la COLONNE ht_score_home', () => {
  const db = prodDb()
  db.prepare(
    `INSERT INTO matches (id, league, scoreHome, scoreAway, status, prediction, fullData, ht_score_home, ht_score_away)
     VALUES ('m1','Test Cup',2,0,'FT',NULL,@fd,1,0)`
  ).run({ fd: JSON.stringify({ ht_pick: 'HT OVER 0.5', ht_pick_prob: 69 }) })
  const r = computeAccuracy({ db, marketFilter: 'ht' })
  expect(r.summary.evaluated).toBe(1)
  expect(r.summary.correct).toBe(1) // 1 but MT -> OVER 0.5, pick OVER -> correct
})

test('historical : score MT lu depuis fullData.ht_score_home (colonne absente)', () => {
  const db = prodDb()
  db.prepare(
    `INSERT INTO historical_matches (id, league, scoreHome, scoreAway, fullData)
     VALUES ('h1','Test Cup',3,2,@fd)`
  ).run({ fd: JSON.stringify({ ht_pick: 'HT UNDER 0.5', ht_pick_prob: 55, ht_score_home: 0, ht_score_away: 0 }) })
  const r = computeAccuracy({ db, marketFilter: 'ht' })
  expect(r.summary.evaluated).toBe(1)
  expect(r.summary.correct).toBe(1) // 0-0 MT -> UNDER 0.5, pick UNDER -> correct
})

test('regression inverse : ht_pick sans AUCUN score MT reste non mesure (jamais un faux correct)', () => {
  const db = prodDb()
  db.prepare(
    `INSERT INTO matches (id, league, scoreHome, scoreAway, status, prediction, fullData, ht_score_home, ht_score_away)
     VALUES ('m2','Test Cup',2,0,'FT',NULL,@fd,NULL,NULL)`
  ).run({ fd: JSON.stringify({ ht_pick: 'HT OVER 0.5' }) })
  const r = computeAccuracy({ db, marketFilter: 'ht' })
  expect(r.summary.evaluated).toBe(0) // pas de score MT -> isCorrect HT null, jamais devine
})
