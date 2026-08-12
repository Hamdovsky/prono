/**
 * Chantier 1 — ordre canonique de la colonne prediction côté PostgreSQL
 *
 * Le fix de pg_database.js:444 (data.prediction || data.enriched?.prediction ||
 * data.verdict || null) doit être testé, pas seulement database.js (SQLite).
 * pg_connector est mocké (pool paresseux — aucun require-time side effect) :
 * on capture les params du `UPDATE matches SET` pour asserter la valeur de $2.
 */

jest.mock('../core/pg_connector', () => ({
  query: jest.fn(),
  usingPostgres: () => true,
  getPool: () => null,
}))

const pgDb = require('../core/pg_database')

function mockRows() {
  const { query } = require('../core/pg_connector')
  query.mockReset()
  query.mockImplementation((sql) => {
    if (String(sql).includes('SELECT "fullData" FROM matches')) {
      return Promise.resolve({ rows: [{ fullData: '{}' }] })
    }
    return Promise.resolve({ rows: [] })
  })
  return query
}

function getUpdateParams(queryMock) {
  const call = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE matches SET'))
  return call ? call[1] : null
}

describe('pg_database — ordre canonique (data.prediction > enriched.prediction > verdict)', () => {
  test('data.prediction gagne sur data.verdict (bug PG latent corrigé)', async () => {
    const queryMock = mockRows()
    await pgDb.updatePredictions('pg-1', { prediction: '2', verdict: 'SAFE' })
    const params = getUpdateParams(queryMock)
    expect(params).not.toBeNull()
    expect(params[1]).toBe('2') // $2 = prediction, pas 'SAFE'
  })

  test('data.enriched.prediction gagne sur data.verdict', async () => {
    const queryMock = mockRows()
    await pgDb.updatePredictions('pg-2', { enriched: { prediction: 'X' }, verdict: 'SAFE' })
    const params = getUpdateParams(queryMock)
    expect(params[1]).toBe('X')
  })

  test('fallback null : sans prediction/verdict → null, jamais RISKY BET', async () => {
    const queryMock = mockRows()
    await pgDb.updatePredictions('pg-3', { home_win_probability: 50 })
    const params = getUpdateParams(queryMock)
    expect(params[1]).toBeNull()
  })

  test('data.verdict seul → verdict conservé (PENDING)', async () => {
    const queryMock = mockRows()
    await pgDb.updatePredictions('pg-4', { verdict: 'PENDING' })
    const params = getUpdateParams(queryMock)
    expect(params[1]).toBe('PENDING')
  })
})
