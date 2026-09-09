/**
 * livescoreSource.test.js — robustesse de la source primaire (retry + blocage
 * souple). axios est entièrement mocké : zéro réseau, backoff réduit via
 * LIVESCORE_RETRIES pour la vitesse des tests.
 */

jest.mock('axios')
const axios = require('axios')

function loadSource(retries) {
  process.env.LIVESCORE_RETRIES = String(retries)
  let mod
  jest.isolateModules(() => {
    mod = require('../config/sources/livescore')
  })
  delete process.env.LIVESCORE_RETRIES
  return mod
}

function ok(stages) {
  return async () => ({ data: { Ts: 1, Stages: stages } })
}
function httpError(status, message) {
  const e = new Error(message || `HTTP ${status}`)
  e.response = { status }
  return async () => {
    throw e
  }
}

describe('_isRetryable', () => {
  const { _isRetryable } = loadSource(0)._internals

  test('erreurs réseau transitoires et 5xx/429 sont retryables', () => {
    expect(_isRetryable({ code: 'ECONNRESET' })).toBe(true)
    expect(_isRetryable({ code: 'ETIMEDOUT' })).toBe(true)
    expect(_isRetryable({ code: 'ENOTFOUND', message: 'getaddrinfo' })).toBe(true)
    expect(_isRetryable({ response: { status: 429 } })).toBe(true)
    expect(_isRetryable({ response: { status: 503 } })).toBe(true)
  })

  test('4xx client (403/410/404) et timeout orchestrateur ne sont PAS retryables', () => {
    expect(_isRetryable({ response: { status: 403 } })).toBe(false)
    expect(_isRetryable({ response: { status: 410 } })).toBe(false)
    expect(_isRetryable({ message: 'fetch timeout (abort)' })).toBe(false)
  })
})

describe('_getDateEvents — retry/backoff', () => {
  beforeEach(() => {
    axios.get = jest.fn()
  })

  test('jour valide (Stages array) : 1 appel, retour direct', async () => {
    const { _getDateEvents } = loadSource(2)._internals
    axios.get.mockImplementation(ok([{ Snm: 'Premier League' }]))
    const stages = await _getDateEvents('2026-09-10')
    expect(stages).toHaveLength(1)
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  test('jour vide légitime (Stages: []) : succès sans retry', async () => {
    const { _getDateEvents } = loadSource(2)._internals
    axios.get.mockImplementation(ok([]))
    expect(await _getDateEvents('2020-01-01')).toEqual([])
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  test('ECONNRESET puis succès : 2 appels, données récupérées', async () => {
    const { _getDateEvents } = loadSource(1)._internals
    axios.get.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    axios.get.mockImplementationOnce(ok([1]))
    expect(await _getDateEvents('2026-09-10')).toEqual([1])
    expect(axios.get).toHaveBeenCalledTimes(2)
  })

  test('200 sans Stages (blocage souple) : retry puis succès', async () => {
    const { _getDateEvents } = loadSource(1)._internals
    axios.get.mockResolvedValueOnce({ data: { Ts: 1 } })
    axios.get.mockImplementationOnce(ok([7]))
    expect(await _getDateEvents('2026-09-10')).toEqual([7])
    expect(axios.get).toHaveBeenCalledTimes(2)
  })

  test('payload persiste sans Stages : LEVE (échec enregistré, plus de faux succès)', async () => {
    const { _getDateEvents } = loadSource(1)._internals
    axios.get.mockResolvedValue({ data: '<html>blocked</html>' })
    await expect(_getDateEvents('2026-09-10')).rejects.toThrow(/invalide/)
    expect(axios.get).toHaveBeenCalledTimes(2)
  })

  test('410 (date hors service) : non retryable, échec immédiat', async () => {
    const { _getDateEvents } = loadSource(2)._internals
    axios.get.mockImplementation(httpError(410, 'Gone'))
    await expect(_getDateEvents('1999-01-01')).rejects.toThrow('Gone')
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  test('5xx persistant : retries puis levée (backoff < 2 s au total)', async () => {
    const { _getDateEvents } = loadSource(1)._internals
    axios.get.mockImplementation(httpError(502, 'Bad gateway'))
    const t0 = Date.now()
    await expect(_getDateEvents('2026-09-10')).rejects.toThrow('Bad gateway')
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('fetch/fetchResults — contrat inchangé au-dessus du retry', () => {
  beforeEach(() => {
    axios.get = jest.fn()
  })

  test('fetch ne garde que les événements NS et les mappe en fixtures', async () => {
    const src = loadSource(0)
    axios.get.mockImplementation(
      ok([
        {
          Snm: 'MLS',
          Events: [
            {
              Eid: 'e1',
              Eps: 'NS',
              Esd: '20260910013000',
              T1: [{ Nm: 'Atlanta', ID: '1' }],
              T2: [{ Nm: 'Orlando', ID: '2' }],
            },
            {
              Eid: 'e2',
              Eps: 'FT',
              Esd: '20260910013000',
              T1: [{ Nm: 'X' }],
              T2: [{ Nm: 'Y' }],
            },
          ],
        },
      ])
    )
    const out = await src.fetch('2026-09-10')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'livescore_e1', status: 'scheduled', league: 'MLS' })
  })

  test('fetchResults transmet un FT mappé (score + status finished)', async () => {
    const src = loadSource(0)
    axios.get.mockImplementation(
      ok([
        {
          Snm: 'Ligue 1',
          Events: [
            {
              Eid: 'e9',
              Eps: 'FT',
              Esd: '20260908190000',
              Tr1: '2',
              Tr2: '1',
              Trh1: '1',
              Trh2: '0',
              T1: [{ Nm: 'PSG' }],
              T2: [{ Nm: 'OM' }],
            },
          ],
        },
      ])
    )
    const out = await src.fetchResults('2026-09-08')
    expect(out[0]).toMatchObject({ status: 'finished', scoreHome: 2, scoreAway: 1, source: 'livescore' })
  })

  test('une erreur réseau éphémère sous fetch() est absorbée par le retry interne', async () => {
    const src = loadSource(1)
    axios.get.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    axios.get.mockImplementation(ok([]))
    expect(await src.fetch('2026-09-10')).toEqual([])
    expect(axios.get).toHaveBeenCalledTimes(2)
  })
})
