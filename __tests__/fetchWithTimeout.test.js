/**
 * fetchWithTimeout — le dashboard ne doit jamais rester en "Chargement..."
 * quand un service ne repond pas (E106 : aucun timeout reseau cote frontend).
 */
const { fetchWithTimeout, FETCH_TIMEOUTS } = require('../src/utils/fetchWithTimeout')

describe('fetchWithTimeout', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    jest.useRealTimers()
  })

  it('retourne la reponse quand le serveur repond a temps', async () => {
    const fakeRes = { ok: true, status: 200 }
    global.fetch = jest.fn(async () => fakeRes)
    const res = await fetchWithTimeout('http://x/api/live', {}, 1000)
    expect(res).toBe(fakeRes)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('transmet les options et un signal d abandon', async () => {
    global.fetch = jest.fn(async () => ({ ok: true }))
    await fetchWithTimeout('http://x/api/combos', { method: 'POST' }, 1000)
    const [, options] = global.fetch.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('leve TimeoutError (timeout: true) quand le serveur ne repond pas', async () => {
    // fetch qui ne se termine jamais, puis AbortController l'interrompt :
    // le signal rejette avec AbortError, converti en TimeoutError.
    global.fetch = jest.fn(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    )
    const err = await fetchWithTimeout('http://x/api/live', {}, 40).catch((e) => e)
    expect(err.name).toBe('TimeoutError')
    expect(err.timeout).toBe(true)
    expect(err.url).toBe('http://x/api/live')
    expect(err.message).toMatch('40 ms')
  })

  it('reemet les erreurs non-timeout telles quelles', async () => {
    const httpErr = new Error('HTTP error! status: 500')
    global.fetch = jest.fn(async () => {
      throw httpErr
    })
    const err = await fetchWithTimeout('http://x/api/live', {}, 1000).catch((e) => e)
    expect(err).toBe(httpErr)
  })

  it('ne laisse pas de timer pendant (pas de fuite de handle)', async () => {
    global.fetch = jest.fn(async () => ({ ok: true }))
    await fetchWithTimeout('http://x/api/live', {}, 50)
    // Si le clearTimeout manquait, ce timer retiendrait le worker Jest.
    expect(jest.getTimerCount()).toBe(0)
  })

  it('expose des delais par usage', () => {
    expect(FETCH_TIMEOUTS.read).toBeGreaterThan(0)
    expect(FETCH_TIMEOUTS.write).toBeGreaterThanOrEqual(FETCH_TIMEOUTS.read)
  })
})
