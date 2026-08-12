/**
 * Chantier 1 (ÉTAPE 2 audit) — Whitelist des labels de prédiction
 *
 * Cas couverts :
 *  1. Fallback null : updatePredictions sans prediction/verdict → colonne null
 *     (plus jamais le défaut 'RISKY BET').
 *  2. Ordre canonique (identique SQLite/PG) : data.prediction > data.enriched.prediction
 *     > data.verdict.
 *  3. PENDING : verdict légitime compté séparément (pendingCount) — ni excludedLabels,
 *     ni noPredictionCount, ni évalué.
 *  4. market_scope : dérivation du marché réel du main_pick (first_half / full_time_* / btts)
 *     + persistance dans fullData via updatePredictions.
 */

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3')
  function MockDatabase(filepath, options) {
    return new Real(':memory:', options)
  }
  return MockDatabase
})

const database = require('../core/database')
const { computeAccuracy } = require('../services/accuracyEngine')
const { marketScopeOf } = require('../core/marketScope')

function insertRaw(overrides = {}) {
  const id = overrides.id || `c1-${Math.random().toString(36).slice(2, 10)}`
  database.db
    .prepare(`
      INSERT INTO matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, status,
                           fullData, timestamp, prediction, confidence,
                           home_win_probability, draw_probability, away_win_probability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      overrides.homeTeam || 'A',
      overrides.awayTeam || 'B',
      overrides.league || 'L1',
      overrides.scoreHome ?? null,
      overrides.scoreAway ?? null,
      overrides.status || 'scheduled',
      overrides.fullData || '{}',
      overrides.timestamp || '2026-08-12T10:00:00.000Z',
      overrides.prediction ?? null,
      overrides.confidence ?? null,
      overrides.home_win_probability ?? null,
      overrides.draw_probability ?? null,
      overrides.away_win_probability ?? null
    )
  return id
}

// ── 1. Fallback null ───────────────────────────────────────────────
describe('Chantier 1 — fallback null (colonne prediction)', () => {
  test('updatePredictions sans prediction/verdict → null, jamais RISKY BET', async () => {
    const id = insertRaw({})
    const ok = await database.updatePredictions(id, { home_win_probability: 65.5 })
    expect(ok).toBe(true)
    const row = database.db.prepare('SELECT prediction FROM matches WHERE id = ?').get(id)
    expect(row.prediction).toBeNull()
  })

  test('updatePredictions avec enriched.prediction seulement → ce pick', async () => {
    const id = insertRaw({})
    await database.updatePredictions(id, { enriched: { prediction: 'X', confidence: 40 } })
    const row = database.db.prepare('SELECT prediction FROM matches WHERE id = ?').get(id)
    expect(row.prediction).toBe('X')
  })

  test('updatePredictions avec verdict seul (PENDING) → verdict conservé', async () => {
    const id = insertRaw({})
    await database.updatePredictions(id, { verdict: 'PENDING' })
    const row = database.db.prepare('SELECT prediction FROM matches WHERE id = ?').get(id)
    expect(row.prediction).toBe('PENDING')
  })

  test('priorité canonique : data.prediction > data.enriched.prediction > data.verdict', async () => {
    const id = insertRaw({})
    await database.updatePredictions(id, { prediction: '2', verdict: 'SAFE' })
    const row = database.db.prepare('SELECT prediction FROM matches WHERE id = ?').get(id)
    expect(row.prediction).toBe('2')
  })

  test('market_scope persiste dans fullData via updatePredictions', async () => {
    const id = insertRaw({})
    await database.updatePredictions(id, { prediction: 'O0.5', market_scope: 'first_half' })
    const row = database.db.prepare('SELECT fullData FROM matches WHERE id = ?').get(id)
    expect(JSON.parse(row.fullData).market_scope).toBe('first_half')
  })
})

// ── 2. PENDING compté séparément ───────────────────────────────────
function makeAccDb(rows) {
  const db = new (require('better-sqlite3'))(':memory:')
  db.exec(`
    CREATE TABLE matches (
      id TEXT PRIMARY KEY,
      homeTeam TEXT, awayTeam TEXT, league TEXT,
      scoreHome INTEGER, scoreAway INTEGER,
      status TEXT, prediction TEXT, confidence REAL,
      home_win_probability REAL, draw_probability REAL, away_win_probability REAL,
      timestamp TEXT, startTimestamp INTEGER
    );
    CREATE TABLE historical_matches (
      id TEXT PRIMARY KEY,
      homeTeam TEXT, awayTeam TEXT, league TEXT,
      scoreHome INTEGER, scoreAway INTEGER,
      fullData TEXT, timestamp TEXT, archived_at TEXT
    );
  `)
  const insM = db.prepare(
    `INSERT INTO matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, status, prediction,
      confidence, home_win_probability, draw_probability, away_win_probability, timestamp, startTimestamp)
     VALUES (@id, @homeTeam, @awayTeam, @league, @scoreHome, @scoreAway, @status, @prediction,
      @confidence, @home_win_probability, @draw_probability, @away_win_probability, @timestamp, @startTimestamp)`
  )
  const insH = db.prepare(
    `INSERT INTO historical_matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, fullData, timestamp, archived_at)
     VALUES (@id, @homeTeam, @awayTeam, @league, @scoreHome, @scoreAway, @fullData, @timestamp, @archived_at)`
  )
  for (const r of rows.matches || []) {
    insM.run({
      home_win_probability: r.home_win_probability ?? null,
      draw_probability: r.draw_probability ?? null,
      away_win_probability: r.away_win_probability ?? null,
      confidence: r.confidence ?? null,
      startTimestamp: r.startTimestamp ?? null,
      ...r,
    })
  }
  for (const r of rows.historical || []) {
    insH.run({ timestamp: r.timestamp ?? null, archived_at: r.archived_at ?? null, ...r })
  }
  return db
}

const TS_BASE = Date.parse('2026-08-10T00:00:00Z')

describe('Chantier 1 — PENDING verdict légitime', () => {
  test('row historique verdict=PENDING → pendingCount, ni excluded ni noPrediction', () => {
    const db = makeAccDb({
      historical: [
        {
          id: 'h-pending', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 1, scoreAway: 1,
          fullData: JSON.stringify({ prediction: null, verdict: 'PENDING', risk_label: 'PENDING' }),
          timestamp: new Date(TS_BASE).toISOString(),
        },
        {
          id: 'h-dirty', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 2, scoreAway: 0,
          fullData: JSON.stringify({ prediction: 'RISKY BET' }),
          timestamp: new Date(TS_BASE).toISOString(),
        },
        {
          id: 'h-ok', homeTeam: 'E', awayTeam: 'F', league: 'L1',
          scoreHome: 2, scoreAway: 1,
          fullData: JSON.stringify({ prediction: '1', confidence: 65 }),
          timestamp: new Date(TS_BASE).toISOString(),
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.pendingCount).toBe(1)
    expect(res.summary.noPredictionCount).toBe(0)
    expect(res.summary.total).toBe(1) // seul le pick évaluable compte
    expect(res.excludedLabels.map((e) => e.label)).toEqual(['RISKYBET'])
  })

  test('row matches prediction=PENDING → pendingCount', () => {
    const db = makeAccDb({
      matches: [
        {
          id: 'm-pending', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 0, scoreAway: 0, status: 'FT', prediction: 'PENDING', confidence: 30,
          timestamp: new Date(TS_BASE).toISOString(), startTimestamp: TS_BASE,
        },
        {
          id: 'm-ok', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 60,
          timestamp: new Date(TS_BASE).toISOString(), startTimestamp: TS_BASE,
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.pendingCount).toBe(1)
    expect(res.summary.total).toBe(1)
    expect(res.excludedLabels).toEqual([])
  })
})

// ── 3. market_scope ────────────────────────────────────────────────
describe('Chantier 1 — market_scope (Option A, informatif)', () => {
  const MARKETS = {
    match_result: { '1': {}, '2': {}, X: {} },
    over_under: { 'O2.5': {}, 'U2.5': {} },
    double_chance: { '12': {}, '1X': {}, X2: {} },
    first_half: { 'O0.5': {}, 'O1.5': {}, BTTS: {} },
    btts: { YES: {}, NO: {} },
  }

  test('O0.5 → first_half (le cas réel des 3 matchs)', () => {
    expect(marketScopeOf('O0.5', MARKETS)).toBe('first_half')
  })

  test('O2.5 / U2.5 → full_time_ou', () => {
    expect(marketScopeOf('O2.5', MARKETS)).toBe('full_time_ou')
    expect(marketScopeOf('U2.5', MARKETS)).toBe('full_time_ou')
  })

  test('1/2/X → full_time_1x2', () => {
    expect(marketScopeOf('1', MARKETS)).toBe('full_time_1x2')
    expect(marketScopeOf('X', MARKETS)).toBe('full_time_1x2')
  })

  test('12/1X/X2 → full_time_dc', () => {
    expect(marketScopeOf('12', MARKETS)).toBe('full_time_dc')
    expect(marketScopeOf('X2', MARKETS)).toBe('full_time_dc')
  })

  test('btts YES/NO → btts', () => {
    expect(marketScopeOf('YES', MARKETS)).toBe('btts')
  })

  test('pick inconnu → unknown ; pick absent → null', () => {
    expect(marketScopeOf('BTTS: YES', MARKETS)).toBe('unknown')
    expect(marketScopeOf(null, MARKETS)).toBeNull()
    expect(marketScopeOf('O0.5', null)).toBe('unknown')
  })
})
