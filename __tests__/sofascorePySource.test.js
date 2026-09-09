const axios = require('axios')
const plugin = require('../config/sources/sofascore-py')
const { getOrComputeMatchKey } = require('../services/matchKey')
const { normalizePlugins } = require('../services/sourceRegistry')

const TS = 1789000000

function ev(overrides = {}) {
  return {
    eid: 111,
    homeTeam: 'Al Nassr',
    awayTeam: 'Al Hilal',
    homeTeamId: 5,
    awayTeamId: 6,
    league: 'Saudi Pro League',
    category_name: 'Saudi Arabia',
    startTimestamp: TS,
    status: 'scheduled',
    statusType: 0,
    ...overrides,
  }
}

const EVENTS = [
  ev(),
  ev({ eid: 222, status: 'inprogress', statusType: 2 }),
  ev({ eid: 333, status: 'finished', statusType: 6, scoreHome: 2, scoreAway: 1 }),
  ev({ eid: 444, status: 'finished', statusType: 6 }),
]

describe('sofascore-py plugin (fixtures via PixelRAG)', () => {
  let spy
  afterEach(() => {
    if (spy) spy.mockRestore()
    spy = null
  })

  it('opt-in (endpoints date Sofascore 404 au 2026-09-09), priorite 2 apres livescore', () => {
    expect(plugin.name).toBe('sofascore-py')
    expect(plugin.priority).toBe(2)
    expect(plugin.enabled).toBe(false) // env PIXELRAG_FIXTURES_ENABLED unset → off
    expect(plugin.timeoutMs).toBeGreaterThan(0)
    expect(typeof plugin.fetch).toBe('function')
    expect(typeof plugin.fetchResults).toBe('function')
  })

  it('fetch() ne garde que les scheduled, en format canonique', async () => {
    spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { success: true, events: EVENTS } })
    const rows = await plugin.fetch('2026-09-10')
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.id).toBe('sofascore_111')
    expect(r.source).toBe('sofascore')
    expect(r.status).toBe('scheduled')
    expect(r.league).toBe('Saudi Pro League')
    expect(r.category_name).toBe('Saudi Arabia')
    expect(Number.isInteger(r.startTimestamp)).toBe(true)
    expect(r.scoreHome).toBeUndefined()
  })

  it('fetchResults() exige status finished + scores entiers', async () => {
    spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { success: true, events: EVENTS } })
    const rows = await plugin.fetchResults('2026-09-08')
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('sofascore_333')
    expect(rows[0].status).toBe('finished')
    expect(rows[0].scoreHome).toBe(2)
    expect(rows[0].scoreAway).toBe(1)
  })

  it('fixture et resultat du meme match partagent leur match_key (dedup cross-source)', async () => {
    spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { success: true, events: [ev()] } })
    const fRows = await plugin.fetch('2026-09-10')
    spy.mockResolvedValue({ data: { success: true, events: [ev({ status: 'finished', statusType: 6, scoreHome: 1, scoreAway: 0 })] } })
    const rRows = await plugin.fetchResults('2026-09-10')
    expect(getOrComputeMatchKey(fRows[0])).toBe(getOrComputeMatchKey(rRows[0]))
  })

  it('payload success=false leve (le health tracker mettra en cooldown)', async () => {
    spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: { success: false, error: 'Sofascore injoignable' } })
    await expect(plugin.fetch('2026-09-10')).rejects.toThrow(/pixelrag fixtures/)
  })

  it('reject reseau remonte egalement (fallback livescore garanti)', async () => {
    spy = jest.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(plugin.fetch('2026-09-10')).rejects.toThrow(/ECONNREFUSED/)
  })

  it('normalizePlugins (opt-in force) : livescore devant sofascore-py (0 < 2 ? le falsy-priority bug est couvert)', () => {
    const livescore = require('../config/sources/livescore')
    const openligadb = require('../config/sources/openligadb')
    const providers = normalizePlugins([
      { ...plugin, enabled: true },
      { ...livescore, enabled: true },
      { ...openligadb, enabled: true },
    ])
    const names = providers.map((p) => p.name)
    // priority 1 (livescore) < 2 (sofascore-py) < 3 (openligadb) ; un 0
    // falsy resterait en tete grace au '?? 99' corrige dans sourceRegistry.
    expect(names[0]).toBe('livescore')
    expect(names).toContain('sofascore-py')
    expect(names.indexOf('sofascore-py')).toBeLessThan(names.indexOf('openligadb'))
  })

  it('regression sourceRegistry : une priorite 0 falsy compte bien comme 0', () => {
    const zero = { ...plugin, name: 'zero-prio-test', priority: 0, enabled: true }
    const providers = normalizePlugins([require('../config/sources/livescore'), zero])
    expect(providers[0].priority).toBe(0)
  })
})

describe('scraperBridge.warmVisualCache (cache visuel chaud)', () => {
  const original = process.env.VISUAL_WARM_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.VISUAL_WARM_ENABLED
    else process.env.VISUAL_WARM_ENABLED = original
  })

  it('retourne skipped quand VISUAL_WARM_ENABLED=false (aucun reseau)', async () => {
    process.env.VISUAL_WARM_ENABLED = 'false'
    const { warmVisualCache } = require('../services/scraperBridge')
    await expect(warmVisualCache()).resolves.toEqual({ warmed: 0, skipped: true })
  })
})

describe('settlementService.purgeStaleScheduled', () => {
  it('exporte purgeStaleScheduled (balayage nocturne des scheduled fantomes)', () => {
    const svc = require('../services/settlementService')
    expect(typeof svc.purgeStaleScheduled).toBe('function')
  })
})
