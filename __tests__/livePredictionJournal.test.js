/**
 * Tests LivePredictionJournal — tracking A/B du CAC (E16.①)
 * bac à sable : LPJ_DIR pointe hors du dépôt (override lu au require).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// setup.js mocke fs mondialement (readFileSync -> '{}') : ce suite a besoin
// du VRAI fs (JSONL append-only dans un bac sabable os.tmpdir).
jest.mock('fs', () => jest.requireActual('fs'))

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lpj-'))
process.env.LPJ_DIR = TMP

const Journal = require('../services/scrapers/LivePredictionJournal')

const mkEvent = (over = {}) => ({
  id: 'ev1',
  homeTeam: 'A FC',
  awayTeam: 'B SC',
  tournament: 'Test League',
  homeScore: 1,
  awayScore: 0,
  liveMinute: 55,
  statusType: 'inprogress',
  pred: { over25: 0.62, under25: 0.38, ou_pick: 'OVER 2.5', total_xg_live: 2.4, xgsrc: 'score_pace' },
  ...over,
})

const readJsonl = (name) =>
  fs
    .readFileSync(path.join(TMP, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('recordEvents — contextual', () => {
  it('compacte le bloc shadow Python + ctx_v1 dans la ligne du journal', () => {
    const winStartRow = mkEvent({
      id: 'ev-shadow',
      contextual: {
        enabled: false,
        shadow: true,
        schema: 'ctx_v1',
        cac_home: 0.91,
        cac_away: 1.04,
        factors: [
          { side: 'home', type: 'injuries', delta: -0.09 },
          { side: 'away', type: 'motivation', delta: 0.04 },
        ],
        alerts: { home: ['🟠 4 pts'], away: [] },
      },
      context: {
        schema: 'ctx_v1',
        teams: {
          home: { european_next: { comp: 'UCL', stage: 'knockout', gap_days: 3 }, rest_hours: 55, motivation: 'STANDARD', absences: [{ player: 'X' }, { player: 'Y' }] },
          away: { european_next: null, rest_hours: 120, motivation: 'TITLE', absences: [] },
        },
      },
    })
    Journal.recordEvents([winStartRow])
    const rows = readJsonl('live_prediction_journal.jsonl').filter((r) => r.eventId === 'ev-shadow')
    expect(rows).toHaveLength(1)
    const c = rows[0].contextual
    expect(c.applied).toBe(false)
    expect(c.shadow).toBe(true)
    expect(c.cac_home).toBe(0.91)
    expect(c.cac_away).toBe(1.04)
    expect(c.factors).toEqual(['home:injuries(-0.09)', 'away:motivation(0.04)'])
    expect(c.alerts).toBe(1)
    expect(c.teams.home.euro).toBe('UCL J+3')
    expect(c.teams.home.rest_h).toBe(55)
    expect(c.teams.away.motivation).toBe('TITLE')
    expect(c.teams.home.absences).toBe(2)
    // Champs préexistants intacts
    expect(rows[0].pick).toBe('OVER 2.5')
    expect(rows[0].resolved).toBe(false)
  })

  it('contextual nulle quand aucune source (lignes anciennes inchangées)', () => {
    Journal.recordEvents([mkEvent({ id: 'ev-bare' })])
    const rows = readJsonl('live_prediction_journal.jsonl').filter((r) => r.eventId === 'ev-bare')
    expect(rows[0].contextual).toBeNull()
  })

  it('flag ON : applied=true propagué', () => {
    Journal.recordEvents([
      mkEvent({ id: 'ev-applied', contextual: { enabled: true, shadow: false, cac_home: 0.95, cac_away: 1.0, factors: [], alerts: { home: [], away: [] } } }),
    ])
    const rows = readJsonl('live_prediction_journal.jsonl').filter((r) => r.eventId === 'ev-applied')
    expect(rows[0].contextual.applied).toBe(true)
    expect(rows[0].contextual.shadow).toBe(false)
  })
})

describe('resolve + stats — tranches A/B', () => {
  it('resolve propage cac et stats groupe applied/shadow/none', () => {
    // ev-applied : total 3 -> OVER correct (pick OVER, hit)
    const outApplied = Journal.resolve('ev-applied', 2, 1)
    expect(outApplied[0].cac.applied).toBe(true)
    // ev-shadow : total 1 -> OVER raté
    const outShadow = Journal.resolve('ev-shadow', 1, 0)
    expect(outShadow[0].cac.applied).toBe(false)
    expect(outShadow[0].cac.shadow).toBe(true)
    // ev-bare : total 4 -> OVER hit, pas de cac
    const outBare = Journal.resolve('ev-bare', 3, 1)
    expect(outBare[0].cac).toBeNull()

    const s = Journal.stats()
    expect(Array.isArray(s.byCac)).toBe(true)
    const byMode = Object.fromEntries(s.byCac.map((e) => [e.mode, e]))
    expect(byMode.applied.n).toBe(1)
    expect(byMode.applied.hit).toBe(1)
    expect(byMode.shadow.n).toBe(1)
    expect(byMode.shadow.hit).toBe(0)
    expect(byMode.none.n).toBeGreaterThanOrEqual(1)
    expect(byMode.none.hit).toBeGreaterThanOrEqual(1)
  })
})
