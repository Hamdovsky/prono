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

  it('seeds the cache /predict actually reads: key match.id, briefing:false, MENA first', async () => {
    process.env.VISUAL_WARM_ENABLED = 'true'
    jest.resetModules()
    const calls = []
    jest.doMock('../services/visualEnrichmentService', () => ({
      getVisualContext: jest.fn(async (m, opts) => {
        calls.push({ id: m.id, league: m.league, opts })
        return { visual_confidence: 0.42 }
      }),
    }))
    const db = require('../core/database')
    const nowSec = Math.floor(Date.now() / 1000)
    // Fenetre 48h purgee d'abord : la DB temp est partagee par les suites du
    // meme worker ; des scheduled residuels fausseraient le tri MENA/limite.
    db.prepare(
      "DELETE FROM matches WHERE status='scheduled' AND startTimestamp > ? AND startTimestamp < ?"
    ).run(nowSec, nowSec + 48 * 3600)
    const seed = [
      { id: 'livescore_w_mena1', homeTeam: 'USM Alger', awayTeam: 'JS El Biar', league: 'Algeria - Ligue 1', ts: nowSec + 7200 },
      { id: 'livescore_w_other1', homeTeam: 'Alpha', awayTeam: 'Beta', league: 'Conference League', ts: nowSec + 3600 },
      { id: 'livescore_w_mena2', homeTeam: 'Club Africain', awayTeam: 'ES Tunis', league: 'Tunisia - Ligue 1', ts: nowSec + 10800 },
      { id: 'livescore_w_other2', homeTeam: 'Gamma', awayTeam: 'Delta', league: 'National League', ts: nowSec + 1800 },
    ]
    for (const s of seed) {
      db.prepare(
        "INSERT INTO matches (id, homeTeam, awayTeam, league, startTimestamp, status) VALUES (?,?,?,?,?,'scheduled')"
      ).run(s.id, s.homeTeam, s.awayTeam, s.league, s.ts)
    }
    try {
      const { warmVisualCache } = require('../services/scraperBridge')
      const out = await warmVisualCache({ limit: 4 })
      expect(out).toEqual({ warmed: 4, total: 4 })
      // briefing:false partout — jamais de LLM speculative
      expect(calls.every((c) => c.opts && c.opts.briefing === false)).toBe(true)
      // Les 2 MENA passent AVANT les 2 autres, malgre des kickoffs plus tardifs
      expect(calls.slice(0, 2).map((c) => c.league).sort()).toEqual(
        ['Algeria - Ligue 1', 'Tunisia - Ligue 1'].sort()
      )
      // MENA trie par kickoff croissant entre eux
      expect(calls[0].id).toBe('livescore_w_mena1')
      expect(calls[1].id).toBe('livescore_w_mena2')
    } finally {
      for (const s of seed) db.prepare('DELETE FROM matches WHERE id=?').run(s.id)
      jest.dontMock('../services/visualEnrichmentService')
    }
  })
})

describe('settlementService.purgeStaleScheduled', () => {
  it('exporte purgeStaleScheduled (balayage nocturne des scheduled fantomes)', () => {
    const svc = require('../services/settlementService')
    expect(typeof svc.purgeStaleScheduled).toBe('function')
  })
})
