/**
 * Archival Guard Tests — ÉTAPE 1 (fix perte de prédiction)
 *
 * Vérifie le cycle de vie complet sur une DB SQLite EN MÉMOIRE (le module
 * core/database est mocké pour pointer vers :memory: au lieu de tactical.db) :
 *   1. archiveFinishedMatches() copie prediction/confidence/probas vers historical_matches
 *   2. anti-écrasement : si le fullData a été écrasé (fullData minimal) mais que les
 *      colonnes indexées portent le verdict, il est ré-injecté à l'archivage
 *   3. mergeFullData (merge gardé) préserve la prédiction dans les DEUX ordres
 *      (service avant prédiction / prédiction avant service)
 *   4. troll lost-update cross-process : ordre aléatoire des deux écritures, la
 *      prédiction survit toujours (ré-injection colonnes→fullData)
 */

jest.mock('better-sqlite3', () => {
  const Real = jest.requireActual('better-sqlite3')
  function MockDatabase(filepath, options) {
    return new Real(':memory:', options)
  }
  return MockDatabase
})

const database = require('../core/database')

function insertMatch(overrides = {}) {
  const id = overrides.id || `m-${Math.random().toString(36).slice(2, 10)}`
  const homeTeam = overrides.homeTeam || 'A'
  const awayTeam = overrides.awayTeam || 'B'
  const league = overrides.league || 'L1'
  const fullData =
    overrides.fullData ||
    JSON.stringify({ id, homeTeam, awayTeam, league })
  database.db
    .prepare(`
      INSERT INTO matches (id, homeTeam, awayTeam, league, scoreHome, scoreAway, status,
                           fullData, timestamp, prediction, confidence,
                           home_win_probability, draw_probability, away_win_probability,
                           expected_score, result, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      overrides.homeTeam || 'A',
      overrides.awayTeam || 'B',
      overrides.league || 'L1',
      overrides.scoreHome ?? null,
      overrides.scoreAway ?? null,
      overrides.status || 'scheduled',
      fullData,
      overrides.timestamp || '2026-08-12T10:00:00.000Z',
      overrides.prediction ?? null,
      overrides.confidence ?? null,
      overrides.home_win_probability ?? null,
      overrides.draw_probability ?? null,
      overrides.away_win_probability ?? null,
      overrides.expected_score ?? null,
      overrides.result ?? null,
      overrides.settled_at ?? null
    )
  return id
}

function getMatch(id) {
  return database.db.prepare('SELECT * FROM matches WHERE id = ?').get(id)
}

function getArchived(id) {
  return database.db.prepare('SELECT * FROM historical_matches WHERE id = ?').get(id)
}

function parseFullData(row) {
  return typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData || {}
}

// PRNG déterministe (mulberry32) pour des ordres "aléatoires" reproductibles.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('ArchivalGuard — archiveFinishedMatches (non-régression)', () => {
  it('conserve prediction/confidence/probas dans historical_matches après le cycle complet', async () => {
    const id = insertMatch({
      status: 'FT',
      prediction: '1',
      confidence: 70,
      home_win_probability: 55,
      draw_probability: 25,
      away_win_probability: 20,
      expected_score: '2 - 1',
      result: 'Home',
      settled_at: 1786300000000,
      fullData: JSON.stringify({ homeTeam: 'A', awayTeam: 'B', league: 'L1', prediction: '1', confidence: 70 }),
    })

    // Un des 4 services de sync passe sur le match (merge gardé).
    database.mergeFullData(id, 'predixsport', { pick: '1' })
    // La prédiction doit survivre au merge (ordre : prédiction == avant le service).
    expect(parseFullData(getMatch(id)).prediction).toBe('1')
    expect(parseFullData(getMatch(id)).predixsport).toEqual({ pick: '1' })

    await database.archiveFinishedMatches()

    const archived = getArchived(id)
    expect(archived).toBeDefined()
    expect(archived.prediction).toBe('1')
    expect(archived.confidence).toBe(70)
    expect(archived.home_win_probability).toBe(55)
    expect(archived.away_win_probability).toBe(20)
    expect(archived.expected_score).toBe('2 - 1')
    expect(archived.result).toBe('Home')
    expect(archived.settled_at).toBe(1786300000000)
    expect(parseFullData(archived).prediction).toBe('1')
    expect(parseFullData(archived).predixsport).toEqual({ pick: '1' })
    // Le match est purgé de `matches`.
    expect(getMatch(id)).toBeUndefined()
  })

  it('anti-écrasement : fullData minimal + colonnes renseignées → verdict ré-injecté à l archivage', async () => {
    // Simule le bug observé : fullData écrasé à 9 clés (style backfill_livescore_scores),
    // mais la colonne prediction porte encore le verdict.
    const clobbered = JSON.stringify({
      id: 'x1',
      homeTeam: 'C',
      awayTeam: 'D',
      league: 'L2',
      startTimestamp: 1786200000,
      status: 'finished',
      homeScore: 3,
      awayScore: 0,
      updatedBy: 'backfill_livescore_scores',
    })
    const id = insertMatch({
      id: 'x1',
      status: 'finished',
      scoreHome: 3,
      scoreAway: 0,
      prediction: '1',
      confidence: 65,
      home_win_probability: 60,
      fullData: clobbered,
    })

    await database.archiveFinishedMatches()

    const archived = getArchived(id)
    const fd = parseFullData(archived)
    expect(archived.prediction).toBe('1')
    expect(archived.confidence).toBe(65)
    expect(archived.home_win_probability).toBe(60)
    // Le fullData copié porte désormais le verdict (anti-écrasement).
    expect(fd.prediction).toBe('1')
    expect(fd.updatedBy).toBe('backfill_livescore_scores')
  })
})

describe('ArchivalGuard — mergeFullData (merge gardé)', () => {
  it('ordre prédiction → service : la prédiction n est jamais perdue', () => {
    const id = insertMatch({
      prediction: 'X',
      confidence: 50,
      home_win_probability: 30,
      draw_probability: 40,
      away_win_probability: 30,
      fullData: JSON.stringify({ homeTeam: 'E', awayTeam: 'F', league: 'L3', prediction: 'X', confidence: 50 }),
    })

    database.mergeFullData(id, 'bigballs', { matchId: 42, league: 7 })

    const fd = parseFullData(getMatch(id))
    expect(fd.prediction).toBe('X')
    expect(fd.confidence).toBe(50)
    expect(fd.home_win_probability).toBe(30)
    expect(fd.away_win_probability).toBe(30)
    expect(fd.bigballs).toEqual({ matchId: 42, league: 7 })
  })

  it('ordre service → prédiction : le pick ajouté ensuite cohabite avec le namespace', async () => {
    // Service s exécute AVANT la prédiction : fullData minimal, colonnes vides.
    const id = insertMatch({ homeTeam: 'G', awayTeam: 'H', league: 'L4' })

    database.mergeFullData(id, 'futpython', { src1: { home: 'G', away: 'H' } })
    let fd = parseFullData(getMatch(id))
    expect(fd.futpython).toEqual({ src1: { home: 'G', away: 'H' } })
    expect(fd.prediction).toBeUndefined()

    // La prédiction arrive ensuite (updatePredictions).
    await database.updatePredictions(id, {
      home_win_probability: 45,
      draw_probability: 30,
      away_win_probability: 25,
      prediction: '1',
      confidence: 60,
      xgboost_confidence: 0.6,
      expected_score: '2 - 1',
      verdict: 'SAFE',
    })

    fd = parseFullData(getMatch(id))
    // Les DEUX vivent dans le même fullData.
    expect(fd.prediction).toBe('1')
    expect(fd.confidence).toBe(60)
    expect(fd.futpython).toEqual({ src1: { home: 'G', away: 'H' } })
    const row = getMatch(id)
    expect(row.prediction).toBe('1')
    expect(row.home_win_probability).toBe(45)
  })

  it('lost-update healing : merge après écrase rétablit le verdict depuis les colonnes', () => {
    // Cas réel : prédiction écrite en colonnes + fullData, puis fullData écrasé.
    const clobbered = JSON.stringify({ id: 'y1', homeTeam: 'I', awayTeam: 'J', status: 'FT', updatedBy: 'backfill_livescore_scores' })
    const id = insertMatch({
      id: 'y1',
      status: 'FT',
      prediction: '2',
      confidence: 80,
      home_win_probability: 15,
      draw_probability: 20,
      away_win_probability: 65,
      fullData: clobbered,
    })

    // Le namespace service écrit par-dessus le fullData écrasé.
    database.mergeFullData(id, 'footballData', { competition: 'WC' })

    const fd = parseFullData(getMatch(id))
    expect(fd.footballData).toEqual({ competition: 'WC' })
    // La ré-injection colonnes→fullData doit restaurer le verdict.
    expect(fd.prediction).toBe('2')
    expect(fd.confidence).toBe(80)
    expect(fd.away_win_probability).toBe(65)
  })
})

describe('ArchivalGuard — race lost-update (ordre aléatoire)', () => {
  it('2 écritures concurrentes (merge namespace + prédiction) : le verdict survit dans N ordres', async () => {
    const rand = mulberry32(20260812)
    const ITERATIONS = 30

    for (let i = 0; i < ITERATIONS; i++) {
      const id = insertMatch({
        fullData: JSON.stringify({ id: `r${i}`, homeTeam: `T${i}a`, awayTeam: `T${i}b`, league: 'L9' }),
      })

      // Ordre aléatoire des deux opérations.
      const predictionFirst = rand() >= 0.5

      const doPrediction = () =>
        database.updatePredictions(id, {
          home_win_probability: 55,
          draw_probability: 25,
          away_win_probability: 20,
          prediction: '1',
          confidence: 70,
          xgboost_confidence: 0.7,
          expected_score: '2 - 0',
          verdict: 'SAFE',
        })
      const doService = () => database.mergeFullData(id, 'bigballs', { matchId: i, seed: predictionFirst })

      const run = async () => {
        if (predictionFirst) {
          await doPrediction()
          doService()
        } else {
          doService()
          await doPrediction()
        }
      }

      // On exécute aussi 3 itérations chaotiques : le service peut réécrire APRÈS
      // la prédiction (simule le lost-update stale-read → ré-injection colonnes).
      await run()
      if (!predictionFirst) {
        // 2ᵉ passe du service APRÈS la prédiction — ré-injection nécessaire.
        database.mergeFullData(id, 'bigballs', { matchId: i, again: true })
      }

      const row = getMatch(id)
      const fd = parseFullData(row)

      // Invariant : une fois la prédiction appliquée, le verdict vit dans le fullData
      // même si un merge précis convient que le namespace est lui aussi présent.
      expect(row.prediction).toBe('1')
      expect(row.confidence).toBe(70)
      expect(fd.confidence).toBe(70)
      expect(fd.prediction).toBe('1')
      expect(fd.home_win_probability).toBe(55)
      expect(fd.bigballs).toBeDefined()
      expect(fd.bigballs.matchId).toBe(i)
    }
  })
})
