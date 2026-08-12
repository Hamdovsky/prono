/**
 * Accuracy Engine Unit Tests — métrique unifiée (ÉTAPE 1 audit)
 *
 * Cas couverts :
 *  1. Nominal : accuracy calculée sur matchs terminés (matches + historical)
 *  2. Whitelist stricte : labels sales exclus ET comptés dans excludedLabels
 *  3. Fenêtres : rolling vs cumulé (même code, filtre temporel différent)
 *  4. Cas 0 match FT : structure valide, accuracy=null, flag `empty`
 *  5. Log-loss / Brier / calibrationCurve / byLeague
 */

const Database = require('better-sqlite3')
const { computeAccuracy } = require('../services/accuracyEngine')

function makeDb(rows) {
  const db = new Database(':memory:')
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
    `INSERT INTO matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, status, prediction, confidence,
      home_win_probability, draw_probability, away_win_probability, timestamp, startTimestamp)
     VALUES (@id, @homeTeam, @awayTeam, @league, @scoreHome, @scoreAway, @status, @prediction, @confidence,
      @home_win_probability, @draw_probability, @away_win_probability, @timestamp, @startTimestamp)`
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
    insH.run({
      timestamp: r.timestamp ?? null,
      archived_at: r.archived_at ?? null,
      ...r,
    })
  }
  return db
}

const TS = {
  day: 24 * 60 * 60 * 1000,
  base: Date.parse('2026-08-10T00:00:00Z'),
}

function histRow({ id = 'h1', home = 'AA', away = 'BB', league = 'Liga', sh = 2, sa = 1, pick = '1', conf = 65, ts = TS.base, probs = { p1: 0.6, px: 0.25, p2: 0.15 } }) {
  return {
    id,
    homeTeam: home,
    awayTeam: away,
    league,
    scoreHome: sh,
    scoreAway: sa,
    timestamp: new Date(ts).toISOString(),
    archived_at: new Date(ts + 3600).toISOString(),
    fullData: JSON.stringify({
      prediction: pick,
      confidence: conf,
      home_win_probability: probs ? probs.p1 * 100 : null,
      draw_probability: probs ? probs.px * 100 : null,
      away_win_probability: probs ? probs.p2 * 100 : null,
      quant: { main_pick: pick },
    }),
  }
}

describe('accuracyEngine — nominal', () => {
  test('calcule accuracy sur matchs FT matches + historical', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'Paris', awayTeam: 'Marseille', league: 'L1',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 70,
          home_win_probability: 65, draw_probability: 20, away_win_probability: 15,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'Lyon', awayTeam: 'Nantes', league: 'L1',
          scoreHome: 0, scoreAway: 0, status: 'FT', prediction: 'X', confidence: 40,
          home_win_probability: 30, draw_probability: 40, away_win_probability: 30,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm3', homeTeam: 'Nice', awayTeam: 'Lens', league: 'L1',
          scoreHome: 1, scoreAway: 2, status: 'FT', prediction: '1', confidence: 55,
          home_win_probability: 50, draw_probability: 25, away_win_probability: 25,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
      historical: [
        histRow({ id: 'h1', league: 'Liga', pick: 'X', sh: 1, sa: 1, conf: 50, probs: { p1: 0.2, px: 0.6, p2: 0.2 } }),
        histRow({ id: 'h2', league: 'Liga', pick: '1X', sh: 3, sa: 2, conf: 80, probs: { p1: 0.5, px: 0.3, p2: 0.2 } }),
      ],
    })

    const res = computeAccuracy({ db })
    // 5 matchs évalués (m1,m2,m3,h1,h2) ; corrects: m1('1'), m2('X'), h1('X'), h2('1X' contient 1) = 4
    expect(res.empty).toBe(false)
    expect(res.summary.total).toBe(5)
    expect(res.summary.evaluated).toBe(5)
    expect(res.summary.correct).toBe(4)
    expect(res.summary.accuracyPct).toBe('80.0%')
  })

  test('gère les doubles chances 1X/X2/12 comme correctes si résultat inclus', () => {
    const db = makeDb({
      historical: [
        histRow({ id: 'a', pick: '12', sh: 1, sa: 2 }), // résultat 2 ∈ {1,2} → correct
        histRow({ id: 'b', pick: '1X', sh: 0, sa: 1 }), // résultat 2 ∉ {1,X} → incorrect
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.correct).toBe(1)
    expect(res.summary.total).toBe(2)
  })

  test('calcule log-loss, brier, calibrationCurve et byLeague', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 80,
          home_win_probability: 80, draw_probability: 10, away_win_probability: 10,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'L2',
          scoreHome: 0, scoreAway: 1, status: 'FT', prediction: '1', confidence: 20,
          home_win_probability: 20, draw_probability: 30, away_win_probability: 50,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.logLoss).not.toBeNull()
    expect(res.summary.brierScore).not.toBeNull()
    expect(res.calibrationCurve.length).toBeGreaterThan(0)
    expect(res.byLeague.length).toBe(2)
    expect(res.byLeague[0].league).toBe('L1')
    // Bande 80-90 contient 1 correct sur 1 ; bande 20-30 : 0 correct sur 1
    const b80 = res.calibrationCurve.find((b) => b.band === '80-90')
    expect(b80.count).toBe(1)
    expect(b80.accuracy).toBe(100)
  })
})

describe('accuracyEngine — whitelist stricte', () => {
  test('exclut les labels sales et les compte dans excludedLabels', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 2, scoreAway: 0, status: 'FT', prediction: 'RISKY BET', confidence: 10,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 0, scoreAway: 0, status: 'FT', prediction: 'O0.5', confidence: 10,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm3', homeTeam: 'E', awayTeam: 'F', league: 'L1',
          scoreHome: 1, scoreAway: 1, status: 'FT', prediction: 'X', confidence: 60,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    // en marketFilter 'all', 'O0.5' est un O/U valide → évalué ; 'RISKY BET' exclu
    expect(res.summary.total).toBe(2) // 'X' + 'O0.5'
    expect(res.summary.correct).toBe(1) // X correct ; O0.5 (0-0, 0 buts) incorrect
    expect(res.excludedLabels.map((e) => e.label)).toEqual(['RISKYBET'])
    // marketFilter '1x2' exclut O0.5 et RISKY BET → seul 'X' reste
    const res12 = computeAccuracy({ db, marketFilter: '1x2' })
    expect(res12.summary.total).toBe(1) // 'X' seulement
    expect(res12.summary.correct).toBe(1)
    expect(res12.excludedLabels.map((e) => e.label)).toEqual(
      expect.arrayContaining(['RISKYBET', 'O0.5'])
    )
  })

  test('O/U : O2.5 correct quand total de buts au-dessus du seuil', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 3, scoreAway: 1, status: 'FT', prediction: 'O2.5', confidence: 70,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: 'O2.5', confidence: 70,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db, marketFilter: 'over_under' })
    expect(res.summary.total).toBe(2)
    expect(res.summary.correct).toBe(1)
  })
})

describe('accuracyEngine — fenêtres', () => {
  test('rolling vs cumulé : même code, filtre temporel différent', () => {
    const db = makeDb({
      matches: [
        {
          id: 'old', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 60,
          timestamp: new Date(TS.base - 20 * TS.day).toISOString(), startTimestamp: TS.base - 20 * TS.day,
        },
        {
          id: 'new', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 60,
          timestamp: new Date(TS.base - 2 * TS.day).toISOString(), startTimestamp: TS.base - 2 * TS.day,
        },
      ],
    })
    const cumul = computeAccuracy({ db, to: TS.base })
    const rolling7 = computeAccuracy({ db, from: TS.base - 7 * TS.day, to: TS.base })
    expect(cumul.summary.total).toBe(2)
    expect(rolling7.summary.total).toBe(1)
    expect(cumul.summary.correct).toBe(2)
    expect(rolling7.summary.correct).toBe(1)
  })
})

describe('accuracyEngine — cas vides', () => {
  test('0 match FT → structure valide, accuracy=null, empty=true, pas de NaN', () => {
    const db = makeDb({
      matches: [
        {
          id: 'sched', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: null, scoreAway: null, status: 'scheduled', prediction: '1', confidence: 60,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.empty).toBe(true)
    expect(res.summary.total).toBe(0)
    expect(res.summary.accuracy).toBeNull()
    expect(res.summary.accuracyPct).toBeNull()
    expect(res.summary.logLoss).toBeNull()
    expect(res.summary.brierScore).toBeNull()
    expect(Number.isNaN(res.summary.accuracy)).toBe(false)
    expect(res.calibrationCurve).toEqual([])
    expect(res.byLeague).toEqual([])
  })

  test('accès DB sans table matches (graceful) ne lève pas', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE historical_matches (id TEXT PRIMARY KEY, homeTeam TEXT, awayTeam TEXT, league TEXT, scoreHome INTEGER, scoreAway INTEGER, fullData TEXT, timestamp TEXT)')
    db.prepare('INSERT INTO historical_matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, fullData) VALUES (?,?,?,?,?,?,?)')
      .run('h1', 'A', 'B', 'L', 2, 1, JSON.stringify({ prediction: '1', confidence: 60 }))
    const res = computeAccuracy({ db })
    expect(res.empty).toBe(false)
    expect(res.summary.total).toBe(1)
  })
})

describe('accuracyEngine — snapshot au temps T', () => {
  test('n\'utilise que la prédiction enregistrée, pas de recalcul post-hoc', () => {
    const db = makeDb({
      historical: [
        histRow({ id: 'h1', pick: 'X', sh: 1, sa: 1 }),
        // fullData archivé : prediction '1' mais résultat 2-1 → la prédiction n'est pas recalculée
        histRow({ id: 'h2', pick: '2', sh: 2, sa: 1 }),
      ],
    })
    const res = computeAccuracy({ db })
    // h1 'X' correct, h2 '2' incorrect (résultat 1) → 1/2
    expect(res.summary.correct).toBe(1)
    expect(res.summary.total).toBe(2)
    // Le pick vient de fullData archivé, pas des colonnes recalculées
    expect(res.summary.accuracyPct).toBe('50.0%')
  })
})
