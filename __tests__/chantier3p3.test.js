/**
 * Chantier 3 — POINT 3 contract tests (dataFusionService.fetchOdds → services/scrapers).
 * L'écriture SQLite RÉELLE des colonnes est testée dans chantier3p3.db.test.js
 * (sans mock de core/database). Ici, core/database et services/scrapers sont mockés.
 */

jest.mock('../core/database', () => ({
  persistOdds: mockPersistOdds,
  updatePredictions: jest.fn(),
}))

jest.mock('../services/scrapers', () => ({
  getOdds: jest.fn(),
}))

const mockPersistOdds = jest.fn()

const database = require('../core/database')
const scrapers = require('../services/scrapers')
const dataFusion = require('../services/dataFusionService')

function serviceWithOnlyScraper() {
  dataFusion.sources = dataFusion.sources.filter((s) => s.name === 'scrapeservice')
  return dataFusion
}

function matchFixture(overrides = {}) {
  return {
    id: 'c3p3_' + Math.random().toString(36).slice(2, 8),
    homeTeam: 'Espérance de Tunis',
    awayTeam: 'CS Sfaxien',
    league: 'Ligue 1',
    category_name: 'Tunisia',
    startTimestamp: 1750000000000,
    status: 'scheduled',
    ...overrides,
  }
}

describe('fetchOdds → services/scrapers (branchement C3P3 + honest gate)', () => {
  let svc

  beforeEach(() => {
    jest.clearAllMocks()
    svc = serviceWithOnlyScraper()
  })

  test('succès: bookmaker flag + odds_source=betexplorer, forwarding {country,date}', async () => {
    scrapers.getOdds.mockResolvedValue({
      home_win: 2.4,
      draw: 3.2,
      away_win: 3.1,
      source: 'betexplorer',
    })

    const m = matchFixture()
    const odds = await svc.fetchOdds(m)

    expect(odds).toEqual({
      home: 2.4,
      draw: 3.2,
      away: 3.1,
      source: 'betexplorer',
      bookmaker: true,
    })
    expect(scrapers.getOdds).toHaveBeenCalledWith(
      'Espérance de Tunis',
      'CS Sfaxien',
      'Ligue 1',
      { country: 'Tunisia', date: 1750000000000 }
    )
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[0]).toBe(m.id)
    expect(persistArgs[1].odds_source).toBe('betexplorer')
    expect(persistArgs[1].odds_fetch_error).toBeNull()
    expect(persistArgs[1].odds_home).toBe(2.4)
  })

  test('country déduit du fullData quand country/category_name absents', async () => {
    scrapers.getOdds.mockResolvedValue({
      home_win: 2.2,
      draw: 3.1,
      away_win: 3.6,
      source: 'betexplorer',
    })

    const m = matchFixture({
      country: undefined,
      category_name: undefined,
      fullData: JSON.stringify({ country: 'Algeria' }),
    })
    await svc.fetchOdds(m)

    expect(scrapers.getOdds).toHaveBeenCalledWith(
      'Espérance de Tunis',
      'CS Sfaxien',
      'Ligue 1',
      { country: 'Algeria', date: 1750000000000 }
    )
  })

  test('échec (aucun match BetExplorer) → null + odds_fetch_error=betexplorer:no_match', async () => {
    scrapers.getOdds.mockResolvedValue(null)

    const m = matchFixture()
    const outcome = await svc.fetchOdds(m)

    expect(outcome).toBeNull()
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[0]).toBe(m.id)
    expect(persistArgs[1].odds_source).toBeNull()
    expect(persistArgs[1].odds_fetch_error).toBe('betexplorer:no_match')
  })

  test('HONESTY GATE: cotes dérivées (source historical) jamais bookmaker', async () => {
    scrapers.getOdds.mockResolvedValue({
      home_win: 1.9,
      draw: 3.4,
      away_win: 4.2,
      source: 'historical',
    })

    const m = matchFixture()
    const outcome = await svc.fetchOdds(m)

    expect(outcome).toBeNull()
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[1].odds_source).toBeNull()
    expect(persistArgs[1].odds_fetch_error).toBe('non_bookmaker:historical')
  })

  test('exception scraper → odds_fetch_error=scrape_exception:...', async () => {
    scrapers.getOdds.mockRejectedValue(new Error('ECONNRESET'))

    const m = matchFixture()
    const outcome = await svc.fetchOdds(m)

    expect(outcome).toBeNull()
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[1].odds_source).toBeNull()
    expect(persistArgs[1].odds_fetch_error).toBe('scrape_exception:ECONNRESET')
  })

  test('market-only: O/U + BTTS sans 1X2 → persiste les 4 colonnes (gate relâché)', async () => {
    scrapers.getOdds.mockResolvedValue({
      over_25: 1.85,
      under_25: 1.9,
      btts_yes: 1.72,
      btts_no: 2.05,
      source: 'betexplorer',
    })

    const m = matchFixture()
    const odds = await svc.fetchOdds(m)

    expect(odds).toEqual({
      home: null,
      draw: null,
      away: null,
      source: 'betexplorer',
      bookmaker: true,
      over25: 1.85,
      under25: 1.9,
      btts_yes: 1.72,
      btts_no: 2.05,
    })
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[1].odds_source).toBe('betexplorer')
    expect(persistArgs[1].odds_fetch_error).toBeNull()
    expect(persistArgs[1].odds_over25).toBe(1.85)
    expect(persistArgs[1].odds_under25).toBe(1.9)
    expect(persistArgs[1].odds_btts_yes).toBe(1.72)
    expect(persistArgs[1].odds_btts_no).toBe(2.05)
    expect(persistArgs[1].odds_home).toBeNull()
  })

  test('1X2 + O/U + BTTS simultanés → tous les marchés passent', async () => {
    scrapers.getOdds.mockResolvedValue({
      home_win: 2.25,
      draw: 3.55,
      away_win: 2.55,
      over_25: 1.45,
      under_25: 2.55,
      btts_yes: 1.42,
      btts_no: 2.68,
      source: 'betexplorer',
    })

    const m = matchFixture()
    const odds = await svc.fetchOdds(m)

    expect(odds).toMatchObject({
      home: 2.25,
      draw: 3.55,
      away: 2.55,
      source: 'betexplorer',
      bookmaker: true,
      over25: 1.45,
      under25: 2.55,
      btts_yes: 1.42,
      btts_no: 2.68,
    })
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[1].odds_over25).toBe(1.45)
    expect(persistArgs[1].odds_btts_yes).toBe(1.42)
  })

  test('market-only depuis source dérivée (default) → toujours gâté par l honesty gate', async () => {
    scrapers.getOdds.mockResolvedValue({
      over_25: 1.85,
      under_25: 1.9,
      btts_yes: 1.72,
      btts_no: 2.05,
      source: 'default',
    })

    const m = matchFixture()
    const outcome = await svc.fetchOdds(m)

    expect(outcome).toBeNull()
    const persistArgs = mockPersistOdds.mock.calls[0]
    expect(persistArgs[1].odds_source).toBeNull()
    expect(persistArgs[1].odds_fetch_error).toBe('non_bookmaker:default')
  })
})
