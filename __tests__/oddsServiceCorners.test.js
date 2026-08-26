// __tests__/oddsServiceCorners.test.js
//
// Test the Corners extraction logic of src/services/oddsService.js.
// Mocks global.fetch to return a payload mirroring Sofascore 2026 real structure.

const path = require('path')
const Module = require('module')

// Mock SofascoreScraping/src/apiClient
const origRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id && id.includes('apiClient')) {
    return { getRandomUserAgent: () => 'Mozilla/5.0 Test' }
  }
  return origRequire.call(this, id)
}

// Build a fake Sofascore /odds/1/all payload (matches real May 2026 format).
const sofaPayload = (choiceGroups) => ({
  markets: [
    { marketId: 1, marketName: 'Full time', marketPeriod: 'Full-time', choices: [
      { name: '1', fractionalValue: '7/4' },
      { name: 'X', fractionalValue: '5/2' },
      { name: '2', fractionalValue: '29/20' },
    ]},
    { marketId: 3, marketName: '1st half', marketPeriod: '1st half', choices: [] },
    ...(choiceGroups || []).map((cg) => ({
      marketId: 21,
      marketName: 'Corners 2-Way',
      marketPeriod: 'Full-time',
      choiceGroup: String(cg.line),
      choices: [
        { name: 'Over', fractionalValue: cg.over },
        { name: 'Under', fractionalValue: cg.under },
      ],
    })),
  ],
})

describe('oddsService Corners extraction', () => {
  beforeEach(() => {
    // Reset cache
    jest.resetModules()
  })

  test('1X2 extracted correctly', async () => {
    global.fetch = async () => ({ ok: true, json: async () => sofaPayload([]) })
    const { getLiveOdds } = require(path.join('..', 'src', 'services', 'oddsService'))
    const o = await getLiveOdds('1')
    expect(o.home).toBeCloseTo(2.75, 2) // 7/4 + 1
    expect(o.draw).toBeCloseTo(3.5, 2)  // 5/2 + 1
    expect(o.away).toBeCloseTo(2.45, 2) // 29/20 + 1
  })

  test('Corners: picks the lowest choiceGroup (main line)', async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => sofaPayload([
        { line: 10.5, over: '1/1', under: '8/11' },
        { line: 9.5,  over: '5/6', under: '5/6' },
      ]),
    })
    const { getLiveOdds } = require(path.join('..', 'src', 'services', 'oddsService'))
    const o = await getLiveOdds('1')
    expect(o.corner_line).toBe(9.5)
    expect(o.corner_over).toBeCloseTo(1.833, 2)
    expect(o.corner_under).toBeCloseTo(1.833, 2)
  })

  test('Corners missing -> all corner fields null', async () => {
    global.fetch = async () => ({ ok: true, json: async () => sofaPayload([]) })
    const { getLiveOdds } = require(path.join('..', 'src', 'services', 'oddsService'))
    const o = await getLiveOdds('1')
    expect(o.corner_line).toBeNull()
    expect(o.corner_over).toBeNull()
    expect(o.corner_under).toBeNull()
  })

  test('HT fields are always null (Sofascore 2026 does not expose HT OU/BTTS)', async () => {
    global.fetch = async () => ({ ok: true, json: async () => sofaPayload([{ line: 9.5, over: '5/6', under: '5/6' }]) })
    const { getLiveOdds } = require(path.join('..', 'src', 'services', 'oddsService'))
    const o = await getLiveOdds('1')
    expect(o.ht_over).toBeNull()
    expect(o.ht_under).toBeNull()
    expect(o.ht_over15).toBeNull()
    expect(o.ht_btts).toBeNull()
  })

  test('null matchId -> null result, no fetch', async () => {
    const { getLiveOdds } = require(path.join('..', 'src', 'services', 'oddsService'))
    const o = await getLiveOdds(null)
    expect(o).toBeNull()
  })

  test('CORNERS_MARKET_ID exported = 21', () => {
    const { CORNERS_MARKET_ID } = require(path.join('..', 'src', 'services', 'oddsService'))
    expect(CORNERS_MARKET_ID).toBe(21)
  })
})
