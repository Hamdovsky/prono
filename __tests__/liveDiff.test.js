/**
 * liveDiff — le poll live (10 s) ne doit pas re-rendre le dashboard quand
 * rien n'a change (E-perf).
 *
 * Contexte : fetchLive() et 'live:update' poussaient un NOUVEAU tableau aux
 * abonnes a chaque poll, meme identique → setLiveMatches → rebuild des 4
 * memos live + re-render des lignes toutes les 10 s. Miroir du diff
 * _setUpcomingPredictions (signature), etendu au live.
 */
jest.mock('../src/config/apiConfig.js', () => ({
  getApiUrl: (p) => `http://127.0.0.1:3001${p}`,
}))
jest.mock('socket.io-client', () => ({ io: jest.fn(() => null) }))

const dataService = require('../src/services/dataService').default

const live1 = () => [
  { id: 101, status: 'LIVE', minute: "54'", scoreHome: 1, scoreAway: 0, prediction: '1' },
  { id: 102, status: 'LIVE', minute: "12'", scoreHome: 0, scoreAway: 0, prediction: 'X' },
]

beforeEach(() => {
  dataService.stopAutoUpdate()
  dataService.liveMatches = []
  dataService._liveSignatureCache = undefined
  dataService.liveSubscribers = []
  global.fetch = jest.fn(() => Promise.reject(new Error('no net in tests')))
})

afterAll(() => {
  dataService.stopAutoUpdate()
})

describe('liveDiff — _liveSignature()', () => {
  it('est stable a identite d objet pres (contenu identique)', () => {
    expect(dataService._liveSignature(live1())).toBe(dataService._liveSignature(live1()))
  })

  it('distingue minute, score et statut', () => {
    const base = dataService._liveSignature(live1())
    const changedMinute = live1()
    changedMinute[0] = { ...changedMinute[0], minute: "55'" }
    expect(dataService._liveSignature(changedMinute)).not.toBe(base)
    const changedScore = live1()
    changedScore[1] = { ...changedScore[1], scoreAway: 1 }
    expect(dataService._liveSignature(changedScore)).not.toBe(base)
    const changedStatus = live1()
    changedStatus[0] = { ...changedStatus[0], status: 'FINISHED' }
    expect(dataService._liveSignature(changedStatus)).not.toBe(base)
  })

  it('distingue l arrivee et le depart d un match', () => {
    expect(dataService._liveSignature(live1())).not.toBe(dataService._liveSignature([live1()[0]]))
    expect(dataService._liveSignature([])).not.toBe(dataService._liveSignature(live1()))
  })
})

describe('liveDiff — _setLiveMatches()', () => {
  it('ne notifie qu une fois pour des payloads identiques', () => {
    const cb = jest.fn()
    dataService.liveSubscribers.push(cb)
    expect(dataService._setLiveMatches(live1())).toBe(true)
    // Meme contenu, NOUVEAUX objets (cas reel : JSON frais du poll) → silence.
    expect(dataService._setLiveMatches(live1())).toBe(false)
    expect(dataService._setLiveMatches(live1())).toBe(false)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(dataService.liveMatches)
  })

  it('notifie quand un score ou une minute change', () => {
    const cb = jest.fn()
    dataService.liveSubscribers.push(cb)
    dataService._setLiveMatches(live1())
    const goal = live1()
    goal[0] = { ...goal[0], minute: "56'", scoreHome: 2 }
    expect(dataService._setLiveMatches(goal)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('notifie la transition vers zero match, puis se tait', () => {
    const cb = jest.fn()
    dataService.liveSubscribers.push(cb)
    dataService._setLiveMatches(live1())
    expect(dataService._setLiveMatches([])).toBe(true)
    expect(dataService._setLiveMatches([])).toBe(false)
    expect(cb).toHaveBeenCalledTimes(2)
  })
})

describe('liveDiff — fetchLive()', () => {
  it('deux polls identiques → un seul notify', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(live1()) })
    )
    const cb = jest.fn()
    dataService.liveSubscribers.push(cb)
    await dataService.fetchLive()
    await dataService.fetchLive()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('un but entre deux polls → deux notifys', async () => {
    const second = live1()
    second[1] = { ...second[1], scoreAway: 1 }
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(live1()) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(second) })
    const cb = jest.fn()
    dataService.liveSubscribers.push(cb)
    await dataService.fetchLive()
    await dataService.fetchLive()
    expect(cb).toHaveBeenCalledTimes(2)
  })
})
