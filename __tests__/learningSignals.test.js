/**
 * learningSignals.test.js — E73.
 *
 * learning_memory ne conservait que le PICK et son sort : ni probabilités, ni
 * vérité terrain, donc aucun Brier / log-loss possible. Ces tests verrouillent
 * les colonnes qui rendent la mesure possible, et les deux pièges déjà vus.
 *
 *   1. `matches.*_probability` est stocké en POURCENTAGE (0-100), pas en [0,1].
 *      Écrire la valeur brute rendrait chaque mesure 100x trop petite et le
 *      modèle semblerait parfait.
 *   2. `actual_1x2` doit venir du SCORE, jamais de `actual` (qui note le sort du
 *      pick — la boucle circulaire constatée sur prediction_history, où le même
 *      match portait à la fois 'won' et 'lost').
 *
 * Aucun réseau, aucun accès au vrai data/tactical.db : base in-memory.
 */
jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/database', () => {
  const Database = require('better-sqlite3')
  const MemoryDB = new Database(':memory:')
  MemoryDB.exec(`
    CREATE TABLE learning_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id    TEXT NOT NULL UNIQUE,
      league      TEXT NOT NULL,
      home_team   TEXT,
      away_team   TEXT,
      score       TEXT,
      prediction  TEXT,
      confidence  REAL,
      actual      TEXT,
      error_type  TEXT,
      root_cause  TEXT,
      context     TEXT,
      tags        TEXT,
      adjustments TEXT,
      new_rule    TEXT,
      match_date  DATETIME,
      root_causes_stack TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      p_home REAL,
      p_draw REAL,
      p_away REAL,
      odds_home REAL,
      odds_draw REAL,
      odds_away REAL,
      actual_1x2 TEXT
    );
    CREATE TABLE league_weights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league TEXT NOT NULL UNIQUE, weights TEXT NOT NULL,
      confidence_adj REAL DEFAULT 0.0, total_cases INTEGER DEFAULT 0,
      accuracy REAL DEFAULT 0.5,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE learning_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league TEXT, rule_type TEXT, condition TEXT, action TEXT,
      confidence REAL, hit_count INTEGER DEFAULT 1,
      last_fired DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(league, rule_type, condition)
    );
    CREATE TABLE league_xg_conversion (
      league TEXT PRIMARY KEY, avg_conv_rate REAL DEFAULT 0.72
    );
    CREATE TABLE league_performance_tracking (
      league TEXT PRIMARY KEY, total_predictions INTEGER DEFAULT 0,
      total_wins INTEGER DEFAULT 0, avg_confidence REAL DEFAULT 0,
      accuracy REAL DEFAULT 0.5, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE league_challenger_weights (
      league TEXT PRIMARY KEY, weights TEXT NOT NULL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE integrity_registry (
      team TEXT PRIMARY KEY, flagged_count INTEGER DEFAULT 0
    );
  `)
  return { db: MemoryDB, isPostgres: () => false, getPool: () => null }
})

const adaptiveLearning = require('../services/adaptiveLearningEngine')
const database = require('../core/database')

const readSignal = (matchId) =>
  database.db
    .prepare(
      'SELECT p_home, p_draw, p_away, actual_1x2, odds_home FROM learning_memory WHERE match_id = ?'
    )
    .get(matchId)

const baseInput = (overrides = {}) => ({
  matchId: 'e73_test_1',
  league: 'Premier League',
  homeTeam: 'Arsenal',
  awayTeam: 'Chelsea',
  prediction: 'Arsenal',
  confidence: 62,
  actualResult: 'won',
  scoreHome: 2,
  scoreAway: 1,
  matchDate: '2026-10-01T20:00:00.000Z',
  matchStats: { xg_home: 1.6, xg_away: 1.1 },
  ...overrides,
})

// learn() renvoie { error } au lieu de lever : on échoue donc explicitement si
// un cas doit avoir persisté, ce qui donne un message lisible en cas de régression.
const expectPersisted = async (input, label) => {
  const res = await adaptiveLearning.learn(input)
  if (res && res.error) {
    throw new Error(`${label}: learn() a echoue -> ${res.error}`)
  }
  return res
}

describe('E73 — signaux de mesure dans learning_memory', () => {
  test('probabilités en POURCENTAGE sont normalisées en [0,1]', async () => {
    await expectPersisted(
      baseInput({
        matchId: 'e73_pct',
        // Comme prediction_engine.py:1168, qui produit des pourcentages.
        home_win_probability: 51.3,
        draw_probability: 23.0,
        away_win_probability: 25.6,
      }),
      'pourcentages'
    )

    const row = readSignal('e73_pct')
    expect(row).toBeDefined()
    expect(row.p_home).toBeGreaterThan(0.4)
    expect(row.p_home).toBeLessThan(0.6)
    expect(row.p_draw).toBeGreaterThan(0.18)
    expect(row.p_draw).toBeLessThan(0.28)
    expect(row.p_home + row.p_draw + row.p_away).toBeCloseTo(1.0, 5)
  })

  test('probabilités déjà en [0,1] ne sont pas ré-étalées', async () => {
    await expectPersisted(
      baseInput({
        matchId: 'e73_unit',
        home_win_probability: 0.55,
        draw_probability: 0.25,
        away_win_probability: 0.2,
      }),
      'unites'
    )
    const row = readSignal('e73_unit')
    expect(row.p_home).toBeCloseTo(0.55, 5)
    expect(row.p_away).toBeCloseTo(0.2, 5)
  })

  test('actual_1x2 déduit du SCORE, pas du sort du pick', async () => {
    // actualResult='lost' décrit le pick perdant ; le score 2-1 dit H.
    await expectPersisted(
      baseInput({ matchId: 'e73_truth', scoreHome: 2, scoreAway: 1, actualResult: 'lost' }),
      'verite'
    )
    expect(readSignal('e73_truth').actual_1x2).toBe('H')
  })

  test('les trois issues terrain sont correctes', async () => {
    for (const [sh, sa, expected] of [
      [2, 1, 'H'],
      [1, 1, 'D'],
      [0, 3, 'A'],
    ]) {
      await expectPersisted(
        baseInput({ matchId: `e73_${expected}`, scoreHome: sh, scoreAway: sa }),
        expected
      )
      expect(readSignal(`e73_${expected}`).actual_1x2).toBe(expected)
    }
  })

  test('cotes transmises sont conservées', async () => {
    await expectPersisted(
      baseInput({
        matchId: 'e73_odds',
        odds_home: 1.85,
        odds_draw: 3.6,
        odds_away: 4.2,
      }),
      'cotes'
    )
    expect(readSignal('e73_odds').odds_home).toBeCloseTo(1.85, 5)
  })

  test('probas absentes -> NULL, jamais de zéros qui pollueraient la mesure', async () => {
    await expectPersisted(baseInput({ matchId: 'e73_none' }), 'absentes')
    const row = readSignal('e73_none')
    expect(row.p_home).toBeNull()
    expect(row.p_draw).toBeNull()
    expect(row.p_away).toBeNull()
    // la vérité terrain, elle, reste disponible
    expect(row.actual_1x2).toBe('H')
  })

  test('probs incohérentes (somme nulle) -> NULL, pas de division par zéro', async () => {
    await expectPersisted(
      baseInput({
        matchId: 'e73_zero',
        home_win_probability: 0,
        draw_probability: 0,
        away_win_probability: 0,
      }),
      'somme nulle'
    )
    const row = readSignal('e73_zero')
    expect(row.p_home).toBeNull()
  })

  test('les probas sont aussi lues depuis fullData (JSON)', async () => {
    await expectPersisted(
      baseInput({
        matchId: 'e73_fd',
        fullData: JSON.stringify({
          home_win_probability: 40,
          draw_probability: 30,
          away_win_probability: 30,
        }),
      }),
      'fullData'
    )
    const row = readSignal('e73_fd')
    expect(row.p_home).toBeCloseTo(0.4, 5)
    expect(row.p_draw).toBeCloseTo(0.3, 5)
  })

  test('un 0 isolé (away = 0) ne casse pas l\'extraction', async () => {
    // Cas réel rencontré en base : 8 matchs à away_win_probability == 0.
    await expectPersisted(
      baseInput({
        matchId: 'e73_iso_zero',
        home_win_probability: 70,
        draw_probability: 30,
        away_win_probability: 0,
      }),
      'zero isole'
    )
    const row = readSignal('e73_iso_zero')
    expect(row.p_away).toBeCloseTo(0, 5)
    expect(row.p_home).toBeCloseTo(0.7, 5)
  })

  test('UPSERT : une ré-exécution met à jour sans dupliquer', async () => {
    const input = baseInput({
      matchId: 'e73_upsert',
      home_win_probability: 50,
    })
    await expectPersisted(input, 'upsert 1')
    await expectPersisted(
      {
        ...input,
        home_win_probability: 65,
        draw_probability: 20,
        away_win_probability: 15,
      },
      'upsert 2'
    )
    const count = database.db
      .prepare('SELECT COUNT(*) AS c FROM learning_memory WHERE match_id = ?')
      .get('e73_upsert')
    expect(count.c).toBe(1)
    expect(readSignal('e73_upsert').p_home).toBeCloseTo(0.65, 5)
  })

  test('matchId absent -> échec VISIBLE (le cron ne peut plus rester muet)', async () => {
    // Défaut réel du cron 02:30 : lignes brutes de `matches`, donc matchId
    // undefined -> INSERT refusé sur match_id NOT NULL, erreur avalée en silence.
    const res = await adaptiveLearning.learn(baseInput({ matchId: undefined }))
    expect(res && res.error).toBeDefined()
  })
})