/**
 * predictions DAO — le verdict ne doit jamais être détruit (E105).
 *
 * Régression observée : le pipeline d'enrichissement (INDEPENDENT-ENRICH,
 * marchés Flashscore, contexte…) appelle `updatePredictions()` en ne passant
 * QUE des probabilités. La colonne `prediction` partait alors à `null`
 * alors qu'un verdict existait déjà dans `fullData`.
 *
 * Constat en base : 8 matchs sur 1643 avaient `fullData.prediction` renseigné
 * ('1X', 'O0.5', '12') mais la colonne `prediction` à `null` — invisibles du
 * dashboard et non pariables.
 *
 * Contrat vérifié : le DAO écrit `UPDATE matches SET "fullData" = ?, prediction = ?`
 * — les deux premiers params de `run()`.
 */
jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

describe('createPredictionsDao.updatePredictions — conservation du verdict', () => {
  let dao
  let row
  let runs

  beforeEach(() => {
    jest.resetModules()
    const { createPredictionsDao } = require('../core/db/predictions')
    row = { fullData: null }
    runs = []

    const db = {
      prepare: jest.fn((sql) => {
        if (/SELECT fullData FROM matches/i.test(sql)) return { get: () => row }
        return {
          run: (...args) => {
            runs.push({ sql, args })
            return { changes: 1 }
          },
        }
      }),
      transaction: jest.fn((fn) => fn()),
    }
    dao = createPredictionsDao(db)
  })

  // Le DAO execute plusieurs `run()` (inserts prediction_history, puis
  // l'UPDATE principal). On cible explicitement l'UPDATE sur `matches`.
  // Attention : l'UPDATE appelle `.run(params)` avec le tableau en argument
  // UNIQUE, alors que les inserts de prediction_history etalent les params
  // un par un. On accepte les deux formes.
  const updateParams = () => {
    const hit = runs.find((r) => /UPDATE\s+matches\s+SET/i.test(r.sql))
    if (!hit) return null
    return Array.isArray(hit.args[0]) ? hit.args[0] : hit.args
  }
  const verdictWritten = () => {
    const p = updateParams()
    return p && p[1]
  }
  const mergedFullData = () => {
    const p = updateParams()
    return p && JSON.parse(p[0])
  }

  it("conserve le verdict existant quand l'appel ne fournit que des probabilites", async () => {
    row = { fullData: { prediction: '1X', league: 'Serie A' } }

    await dao.updatePredictions('m1', {
      home_win_probability: 51.3,
      draw_probability: 26.5,
      away_win_probability: 22.3,
      ou_25_prob: 50,
      btts_prob: 48,
      confidence: 78,
    })

    expect(verdictWritten()).toBe('1X')
    expect(mergedFullData().prediction).toBe('1X')
    // les probabilites, elles, doivent bien etre mises a jour
    expect(mergedFullData().home_win_probability).toBe(51.3)
  })

  it('un verdict explicitement fourni prime sur le precedent', async () => {
    row = { fullData: { prediction: '1X' } }

    await dao.updatePredictions('m1', {
      prediction: '12',
      home_win_probability: 60,
      draw_probability: 20,
      away_win_probability: 20,
    })

    expect(verdictWritten()).toBe('12')
  })

  it('ne fabrique pas de verdict quand il n en existe aucun', async () => {
    row = { fullData: { league: 'Liga 2' } }

    await dao.updatePredictions('m1', {
      home_win_probability: 40,
      draw_probability: 30,
      away_win_probability: 30,
    })

    expect(verdictWritten() === null || verdictWritten() === undefined).toBe(true)
  })

  it('reste tolerant si fullData est stocke en chaine JSON', async () => {
    row = { fullData: JSON.stringify({ prediction: 'O0.5' }) }

    await dao.updatePredictions('m1', {
      home_win_probability: 55,
      draw_probability: 25,
      away_win_probability: 20,
    })

    expect(verdictWritten()).toBe('O0.5')
  })

  it('accepte verdict et main_pick comme porteurs du verdict precedent', async () => {
    row = { fullData: { main_pick: 'X' } }

    await dao.updatePredictions('m1', {
      home_win_probability: 33,
      draw_probability: 34,
      away_win_probability: 33,
    })

    expect(verdictWritten()).toBe('X')
  })
})