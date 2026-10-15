/**
 * E101 — normalizeTsToSeconds : garde-fou anti-régression du bug d'unités.
 *
 * resolveEvent() divisait aveuglément le startTimestamp par 1000 en supposant
 * des millisecondes, alors que la DB (colonne "startTimestamp") et fullData
 * stockent des SECONDES (unité native Sofascore). Résultat : --ts 1789837
 * (1970-01-21) → le filtre ±7 jours de sofascore_bypass.py rejetait tout →
 * "event_not_found" → RETRO-SYNC / settlement / odds ignoraient silencieusement
 * les matchs (ex: "No SofaScore event resolved for livescore_1884464").
 *
 * Tests 100 % offline : execFile mocké, aucun appel Python / réseau.
 */
jest.mock('child_process', () => ({ execFile: jest.fn() }))
const { execFile } = require('child_process')
const { normalizeTsToSeconds, resolveEvent } = require('../services/scrapers/SofascoreBypass')

/** Simule le pont Python : capture les args et renvoie une ligne JSON. */
function mockPy(response) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    mockPy.lastArgs = args
    cb(null, JSON.stringify(response) + '\n', '')
  })
}

describe('normalizeTsToSeconds', () => {
  test('epoch SECONDS passe tel quel (régression bug E101)', () => {
    // cas réel livescore_1884464 (Mafra vs Tirsense, Taça de Portugal)
    expect(normalizeTsToSeconds(1789837200)).toBe(1789837200)
  })

  test('epoch MILLI-SECONDES est converti en secondes', () => {
    expect(normalizeTsToSeconds(1789837200000)).toBe(1789837200)
  })

  test('format AAAAMMJJ est converti en minuit UTC', () => {
    const expected = Math.floor(Date.parse('2026-09-15T00:00:00Z') / 1000)
    expect(normalizeTsToSeconds(20260915)).toBe(expected)
  })

  test('secondes fractionnelles tronquées', () => {
    expect(normalizeTsToSeconds(1789837200.9)).toBe(1789837200)
  })

  test('valeurs inutilisables → null', () => {
    expect(normalizeTsToSeconds(null)).toBe(null)
    expect(normalizeTsToSeconds(undefined)).toBe(null)
    expect(normalizeTsToSeconds(0)).toBe(null)
    expect(normalizeTsToSeconds(-5)).toBe(null)
    expect(normalizeTsToSeconds('abc')).toBe(null)
    expect(normalizeTsToSeconds('')).toBe(null)
    expect(normalizeTsToSeconds(NaN)).toBe(null)
  })

  test('strings numériques acceptées', () => {
    expect(normalizeTsToSeconds('1789837200')).toBe(1789837200)
    expect(normalizeTsToSeconds('1789837200000')).toBe(1789837200)
  })
})

describe('resolveEvent — passage de --ts normalisé', () => {
  afterEach(() => jest.clearAllMocks())

  test('reçoit des secondes (DB) et les transmet intactes', async () => {
    mockPy({ found: true, event_id: 16988026, start_timestamp: 1789837200 })
    const id = await resolveEvent('Mafra Club', 'Tirsense FC', 1789837200)
    expect(id).toBe(16988026)
    const tsIdx = mockPy.lastArgs.indexOf('--ts')
    expect(tsIdx).toBeGreaterThan(-1)
    expect(mockPy.lastArgs[tsIdx + 1]).toBe('1789837200')
  })

  test('reçoit des milli-secondes (Date.parse) et convertit', async () => {
    mockPy({ found: true, event_id: 111, start_timestamp: 1789837200 })
    const id = await resolveEvent('Alpha United', 'Beta City', 1789837200000)
    expect(id).toBe(111)
    const tsIdx = mockPy.lastArgs.indexOf('--ts')
    expect(mockPy.lastArgs[tsIdx + 1]).toBe('1789837200')
  })

  test('sans timestamp : --ts omis', async () => {
    mockPy({ found: true, event_id: 222 })
    const id = await resolveEvent('Gamma FC', 'Delta FC', null)
    expect(id).toBe(222)
    expect(mockPy.lastArgs).not.toContain('--ts')
  })

  test('timestamp inutilisable : --ts omis (pas de 1970)', async () => {
    mockPy({ found: true, event_id: 333 })
    const id = await resolveEvent('Epsilon FC', 'Zeta FC', 'not-a-ts')
    expect(id).toBe(333)
    expect(mockPy.lastArgs).not.toContain('--ts')
  })
})
