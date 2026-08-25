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
      odds_home REAL, odds_draw REAL, odds_away REAL, kelly_stake REAL,
      btts_prob REAL, btts_pick TEXT, btts_pick_prob REAL,
      odds_btts_yes REAL, odds_btts_no REAL,
      odds_over25 REAL, odds_under25 REAL,
      corner_pick TEXT, corner_pick_prob REAL, ht_pick TEXT, ht_pick_prob REAL,
      corners_home INTEGER, corners_away INTEGER, score_home_ht INTEGER, score_away_ht INTEGER,
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
      home_win_probability, draw_probability, away_win_probability,
      odds_home, odds_draw, odds_away, kelly_stake,
      btts_prob, btts_pick, btts_pick_prob, odds_btts_yes, odds_btts_no,
      odds_over25, odds_under25,
      corner_pick, corner_pick_prob, ht_pick, ht_pick_prob,
      corners_home, corners_away, score_home_ht, score_away_ht,
      timestamp, startTimestamp)
     VALUES (@id, @homeTeam, @awayTeam, @league, @scoreHome, @scoreAway, @status, @prediction, @confidence,
      @home_win_probability, @draw_probability, @away_win_probability,
      @odds_home, @odds_draw, @odds_away, @kelly_stake,
      @btts_prob, @btts_pick, @btts_pick_prob, @odds_btts_yes, @odds_btts_no,
      @odds_over25, @odds_under25,
      @corner_pick, @corner_pick_prob, @ht_pick, @ht_pick_prob,
      @corners_home, @corners_away, @score_home_ht, @score_away_ht,
      @timestamp, @startTimestamp)`
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
      odds_home: r.odds_home ?? null,
      odds_draw: r.odds_draw ?? null,
      odds_away: r.odds_away ?? null,
      kelly_stake: r.kelly_stake ?? null,
      startTimestamp: r.startTimestamp ?? null,
      btts_prob: r.btts_prob ?? null,
      btts_pick: r.btts_pick ?? null,
      btts_pick_prob: r.btts_pick_prob ?? null,
      odds_btts_yes: r.odds_btts_yes ?? null,
      odds_btts_no: r.odds_btts_no ?? null,
      odds_over25: r.odds_over25 ?? null,
      odds_under25: r.odds_under25 ?? null,
      corner_pick: r.corner_pick ?? null,
      corner_pick_prob: r.corner_pick_prob ?? null,
      ht_pick: r.ht_pick ?? null,
      ht_pick_prob: r.ht_pick_prob ?? null,
      corners_home: r.corners_home ?? null,
      corners_away: r.corners_away ?? null,
      score_home_ht: r.score_home_ht ?? null,
      score_away_ht: r.score_away_ht ?? null,
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
    // Moyennes réelles (sum/n), unités naturelles — PAS ×100/×1000
    // m1 : -ln(0.80)=0.2231, m2 : -ln(0.50)=0.6931 → avg 0.4581
    expect(res.summary.logLoss).toBeCloseTo(0.4581, 4)
    // m1 brier : (0.8-1)²+(0.1-0)²+(0.1-0)²=0.06 ; m2 : (0.2)²+(0.3)²+(0.5-1)²=0.38 → avg 0.22
    expect(res.summary.brierScore).toBeCloseTo(0.22, 4)
    expect(res.calibrationCurve.length).toBeGreaterThan(0)
    expect(res.byLeague.length).toBe(2)
    expect(res.byLeague[0].league).toBe('L1')
    // Bande 80-90 contient 1 correct sur 1 ; bande 20-30 : 0 correct sur 1
    const b80 = res.calibrationCurve.find((b) => b.band === '80-90')
    expect(b80.count).toBe(1)
    expect(b80.accuracy).toBe(100)
  })

  test('calcule le ROI (flat 1u + Quarter-Kelly cap 2%) et exclut les odds manquantes', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 80,
          home_win_probability: 80, draw_probability: 10, away_win_probability: 10,
          odds_home: 1.60, odds_draw: 4.0, odds_away: 6.0, kelly_stake: 3.0,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'L1',
          scoreHome: 0, scoreAway: 1, status: 'FT', prediction: '1', confidence: 20,
          home_win_probability: 20, draw_probability: 30, away_win_probability: 50,
          odds_home: 1.50, odds_draw: 4.0, odds_away: 6.0, kelly_stake: 1.0,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm3', homeTeam: 'E', awayTeam: 'F', league: 'L1',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 55,
          home_win_probability: 50, draw_probability: 25, away_win_probability: 25,
          odds_home: null, odds_draw: null, odds_away: null,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    // m1 gagné (1) @1.60 → flat profit +0.60 ; m2 perdu → -1 ; m3 sans cotes → exclu
    expect(res.summary.roiBets).toBe(2)
    expect(res.summary.roiExcluded).toBe(1)
    expect(res.summary.staked).toBe(2)
    expect(res.summary.netProfit).toBeCloseTo(-0.4, 6)
    expect(res.summary.roi).toBeCloseTo(-20, 6)
    // Quarter-Kelly : stake archivé 3%×0.25=0.0075 + 1%×0.25=0.0025 → 0.01 (cap 2% = 0.02 non atteint)
    expect(res.summary.kellyBets).toBe(2)
    expect(res.summary.kellyStaked).toBeCloseTo(0.01, 6)
    // kelly m1 : +0.0075*(1.6-1)=+0.0045 ; m2 : -0.0025 → net 0.0020
    expect(res.summary.kellyNetProfit).toBeCloseTo(0.002, 6)
  })

  test('cap explicite du Quarter-Kelly à 2% du bankroll', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'L1',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 95,
          home_win_probability: 95, draw_probability: 3, away_win_probability: 2,
          odds_home: 1.10, odds_draw: 9.0, odds_away: 20.0, kelly_stake: 20.0,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    // 20% × 0.25 = 0.05 brut → capé à 0.02 (2 % du bankroll)
    expect(res.summary.kellyBets).toBe(1)
    expect(res.summary.kellyStaked).toBeCloseTo(0.02, 6)
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
    expect(res.summary.roi).toBeNull()
    expect(res.summary.roiBets).toBe(0)
    expect(res.summary.staked).toBe(0)
    expect(res.summary.netProfit).toBe(0)
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

// ── Audit BT2 (2026-08-24) — marché BTTS émis via fullData.btts_pick ──
describe('accuracyEngine — marché BTTS', () => {
  function bttsRow({ id, pick = 'X', sh, sa, bttsPick, bttsProb = 71, oYes = 1.85, oNo = 2.0 }) {
    return {
      id,
      homeTeam: 'H' + id,
      awayTeam: 'A' + id,
      league: 'L1',
      scoreHome: sh,
      scoreAway: sa,
      status: 'FT',
      prediction: pick,
      confidence: 60,
      timestamp: new Date(TS.base).toISOString(),
      startTimestamp: TS.base,
      btts_prob: bttsProb,
      btts_pick: bttsPick,
      odds_btts_yes: oYes,
      odds_btts_no: oNo,
    }
  }

  test('second record BTTS émis quand fullData/colonne btts_pick présent', () => {
    const db = makeDb({
      matches: [bttsRow({ id: 'm1', pick: 'X', sh: 1, sa: 1, bttsPick: 'BTTS YES' })],
    })
    const res = computeAccuracy({ db })
    // 2 records : le pick principal 'X' (correct sur 1-1) + 'BTTS YES' (correct)
    expect(res.summary.total).toBe(2)
    expect(res.summary.correct).toBe(2)
    const mk = Object.fromEntries(res.byMarket.map((m) => [m.market, m]))
    expect(mk.BTTS).toBeDefined()
    expect(mk.BTTS.total).toBe(1)
    expect(mk.BTTS.correct).toBe(1)
  })

  test('BTTS NO incorrect sur match avec buts des deux côtés', () => {
    const db = makeDb({
      matches: [
        bttsRow({ id: 'm1', sh: 1, sa: 1, bttsPick: 'BTTS NO' }),
        bttsRow({ id: 'm2', sh: 2, sa: 0, bttsPick: 'BTTS NO' }),
      ],
    })
    const res = computeAccuracy({ db })
    // m1 : BTTS NO perdu (1-1) ; m2 : BTTS NO gagné (2-0). Picks principaux X→? hors scope :
    // m1 X correct, m2 X incorrect → total records 4, corrects attendus 2 (BTTS m2 + X m1)
    expect(res.summary.total).toBe(4)
    expect(res.summary.correct).toBe(2)
    const mk = Object.fromEntries(res.byMarket.map((m) => [m.market, m]))
    expect(mk.BTTS.accuracy).toBe(50)
  })

  test('ROI flat sur cote BTTS + filtre marketFilter=btts', () => {
    const db = makeDb({
      matches: [bttsRow({ id: 'm1', sh: 1, sa: 1, bttsPick: 'BTTS YES', oYes: 1.85 })],
    })
    const resAll = computeAccuracy({ db })
    expect(resAll.byMarket.find((m) => m.market === 'BTTS').roiBets).toBe(1)
    expect(resAll.byMarket.find((m) => m.market === 'BTTS').flatRoi).toBe(85)

    const resBtts = computeAccuracy({ db, marketFilter: 'btts' })
    expect(resBtts.summary.total).toBe(1)
    expect(resBtts.byMarket[0].market).toBe('BTTS')

    const res12 = computeAccuracy({ db, marketFilter: '1x2' })
    // Le filtre 1x2 exclut le record BTTS → seul le pick principal reste
    expect(res12.summary.total).toBe(1)
    expect(res12.byMarket.some((m) => m.market === 'BTTS')).toBe(false)
  })

  test('historical_matches : btts_pick depuis fullData archivé (snapshot T)', () => {
    const db = makeDb({
      historical: [
        {
          id: 'h1', homeTeam: 'AA', awayTeam: 'BB', league: 'Liga',
          scoreHome: 0, scoreAway: 0,
          timestamp: new Date(TS.base).toISOString(),
          archived_at: new Date(TS.base + 3600).toISOString(),
          fullData: JSON.stringify({
            prediction: 'X',
            confidence: 60,
            btts_pick: 'BTTS YES',
            btts_prob: 66,
          }),
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.total).toBe(2)
    const mk = Object.fromEntries(res.byMarket.map((m) => [m.market, m]))
    // 0-0 → BTTS YES incorrect
    expect(mk.BTTS.correct).toBe(0)
    expect(mk.BTTS.total).toBe(1)
  })

  test('historical_matches : btts_pick depuis fullData archivé (snapshot T)', () => {
    const db = makeDb({
      historical: [
        {
          id: 'h1', homeTeam: 'AA', awayTeam: 'BB', league: 'Liga',
          scoreHome: 0, scoreAway: 0,
          timestamp: new Date(TS.base).toISOString(),
          archived_at: new Date(TS.base + 3600).toISOString(),
          fullData: JSON.stringify({
            prediction: 'X',
            confidence: 60,
            btts_pick: 'BTTS YES',
            btts_prob: 66,
          }),
        },
      ],
    })
    const res = computeAccuracy({ db })
    expect(res.summary.total).toBe(2)
    const mk = Object.fromEntries(res.byMarket.map((m) => [m.market, m]))
    // 0-0 → BTTS YES incorrect
    expect(mk.BTTS.correct).toBe(0)
    expect(mk.BTTS.total).toBe(1)
  })

  // ── Audit Phase 1 FD-Odds (2026-08-24) — marché O/U avec cotes réelles ──
  test('ROI flat sur cotes O/U 2.5 archivées (bridge football-data)', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'E0',
          scoreHome: 3, scoreAway: 1, status: 'FT', prediction: 'O2.5', confidence: 70,
          odds_over25: 1.85, odds_under25: 2.05,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'E0',
          scoreHome: 3, scoreAway: 1, status: 'FT', prediction: 'U2.5', confidence: 70,
          odds_over25: 1.85, odds_under25: 2.05,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    const ou = res.byMarket.find((m) => m.market === 'OU')
    expect(ou.roiBets).toBe(2)
    // m1 O gagné @1.85 (+0.85), m2 U perdu (-1) → net -0.15 / 2 misés
    expect(ou.flatRoi).toBe(-7.5)
    expect(res.byMarket.find((m) => m.market === 'OU').avgOddsWinners).toBe(1.85)
    // Le marché OU alimente aussi le résumé ROI global
    expect(res.summary.roiBets).toBe(2)
  })

  test('pickOdds O/U : seuils autres que 2.5 restent exclus du ROI', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'E0',
          scoreHome: 2, scoreAway: 2, status: 'FT', prediction: 'O3.5', confidence: 60,
          odds_over25: 1.9, odds_under25: 2.0,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db })
    // évalué pour l'accuracy mais sans pari possible (pas de cote O3.5 archivée)
    expect(res.summary.evaluated).toBe(1)
    expect(res.summary.roiBets).toBe(0)
    expect(res.summary.oddsMissingByMarket.OU).toBe(1)
  })
})

describe('accuracyEngine — Q1 marchés Corners / HT', () => {
  test('record Corners secondaire : settle sur le total de corners réel', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'E0',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 70,
          corners_home: 6, corners_away: 5, // total 11 > 9.5 → OVER
          corner_pick: 'CORNERS OVER 9.5', corner_pick_prob: 60,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'E0',
          scoreHome: 1, scoreAway: 0, status: 'FT', prediction: '1', confidence: 70,
          corners_home: 4, corners_away: 3, // total 7 < 9.5 → UNDER
          corner_pick: 'CORNERS UNDER 9.5', corner_pick_prob: 60,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db, marketFilter: 'corners' })
    expect(res.summary.evaluated).toBe(2)
    expect(res.summary.correct).toBe(2)
    expect(res.summary.accuracy).toBe(1)
  })

  test('record Corners : sans total de corners réel → exclu (actual null)', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'E0',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 70,
          corner_pick: 'CORNERS OVER 9.5', corner_pick_prob: 60,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db, marketFilter: 'corners' })
    expect(res.summary.evaluated).toBe(0)
  })

  test('record HT secondaire : settle sur le score de la 1re mi-temps réel', () => {
    const db = makeDb({
      matches: [
        {
          id: 'm1', homeTeam: 'A', awayTeam: 'B', league: 'E0',
          scoreHome: 2, scoreAway: 1, status: 'FT', prediction: '1', confidence: 70,
          score_home_ht: 1, score_away_ht: 0, // 1 but HT → OVER 0.5
          ht_pick: 'HT OVER 0.5', ht_pick_prob: 55,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
        {
          id: 'm2', homeTeam: 'C', awayTeam: 'D', league: 'E0',
          scoreHome: 0, scoreAway: 0, status: 'FT', prediction: 'X', confidence: 70,
          score_home_ht: 0, score_away_ht: 0, // 0 but HT → UNDER 0.5
          ht_pick: 'HT UNDER 0.5', ht_pick_prob: 55,
          timestamp: new Date(TS.base).toISOString(), startTimestamp: TS.base,
        },
      ],
    })
    const res = computeAccuracy({ db, marketFilter: 'ht' })
    expect(res.summary.evaluated).toBe(2)
    expect(res.summary.correct).toBe(2)
    expect(res.summary.accuracy).toBe(1)
  })

  test('pickProbability Corners / HT renvoie la proba normalisée', () => {
    const { pickProbability } = require('../services/accuracyEngine')
    // pickProbability reçoit un label déjà normalisé (espaces supprimés)
    expect(pickProbability('CORNERSOVER9.5', { pCorner: 0.62 })).toBe(62)
    expect(pickProbability('HTUNDER0.5', { pHT: 0.4 })).toBe(40)
  })
})
