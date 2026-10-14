/**
 * E91 — RETRO-SYNC ne doit plus envoyer l'id interne ("livescore_xxxx") à
 * SofaScore : il résout d'abord le vrai event id numérique via le bypass
 * curl_cffi, et n'appelle l'API que si la résolution réussit.
 */
jest.mock('../core/database', () => ({ prepare: jest.fn() }))
jest.mock('../services/scrapers/SofascoreBypass', () => ({
  resolveEvent: jest.fn(),
  getEventStatus: jest.fn(),
  getEventStats: jest.fn(),
}))

const db = require('../core/database')
const sofa = require('../services/scrapers/SofascoreBypass')
const retro = require('../services/retroSyncService')

describe('retroSyncService — résolution SofaScore (E91)', () => {
  const OLD_DB_URL = process.env.DATABASE_URL

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.DATABASE_URL
  })

  afterAll(() => {
    if (OLD_DB_URL) process.env.DATABASE_URL = OLD_DB_URL
  })

  it('ne fait aucun appel SofaScore si aucun match en attente', async () => {
    db.prepare.mockReturnValue({ all: () => [], run: jest.fn() })
    const r = await retro.syncPastMatches()
    expect(r.processed).toBe(0)
    expect(sofa.resolveEvent).not.toHaveBeenCalled()
  })

  it("skip sans appel si aucun event résolu (id bidon)", async () => {
    const run = jest.fn()
    db.prepare.mockReturnValue({
      all: () => [{ id: 'livescore_1', homeTeam: 'A', awayTeam: 'B', fullData: '{}' }],
      run,
    })
    sofa.resolveEvent.mockResolvedValue(null)
    const r = await retro.syncPastMatches()
    expect(r.processed).toBe(0)
    expect(sofa.getEventStatus).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('résout, récupère le score final et met à jour fullData', async () => {
    const run = jest.fn()
    db.prepare.mockReturnValue({
      all: () => [
        {
          id: 'livescore_2',
          homeTeam: 'A',
          awayTeam: 'B',
          fullData: '{"startTimestamp":1700000000000}',
        },
      ],
      run,
    })
    sofa.resolveEvent.mockResolvedValue(555)
    sofa.getEventStatus.mockResolvedValue({
      found: true,
      finished: true,
      home: 2,
      away: 1,
      status: 'finished',
    })
    sofa.getEventStats.mockResolvedValue({
      found: true,
      expectedGoalsHome: 1.6,
      expectedGoalsAway: 0.8,
      possessionHome: 60,
      possessionAway: 40,
    })

    const r = await retro.syncPastMatches()
    expect(r.processed).toBe(1)
    expect(run).toHaveBeenCalledTimes(1)

    const args = run.mock.calls[0]
    expect(args[0]).toBe(2)
    expect(args[1]).toBe(1)
    const fd = JSON.parse(args[2])
    expect(fd._sofaEventId).toBe(555)
    expect(fd.score).toEqual({ home: 2, away: 1 })
    expect(fd.status).toBe('finished')
    expect(Array.isArray(fd.stats)).toBe(true)
    expect(fd.stats.some((s) => /expected goals/i.test(s.name))).toBe(true)
  })

  it('ne met pas à jour si le match n’est pas terminé', async () => {
    const run = jest.fn()
    db.prepare.mockReturnValue({
      all: () => [{ id: 'livescore_3', homeTeam: 'A', awayTeam: 'B', fullData: '{}' }],
      run,
    })
    sofa.resolveEvent.mockResolvedValue(777)
    sofa.getEventStatus.mockResolvedValue({ found: true, finished: false, status: 'inprogress' })

    const r = await retro.syncPastMatches()
    expect(r.processed).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })
})
