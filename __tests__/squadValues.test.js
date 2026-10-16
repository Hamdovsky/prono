/**
 * E121 — snapshots de valeurs d'effectifs (parse, sans reseau : fetchPage
 * moquee avec le HTML observe en production).
 */
const cheerio = require('cheerio')
const svc = require('../services/transfermarktService')
const { parseMarketValue } = require('../services/transfermarktService')

const withPage = (bodyHtml) => {
  jest.spyOn(svc, 'fetchPage').mockResolvedValueOnce(cheerio.load(
    `<html><body>${bodyHtml}</body></html>`
  ))
}

describe('getTeamValue (E121)', () => {
  afterEach(() => jest.restoreAllMocks())

  it('parse les millions', async () => {
    withPage('<div><span class="marktwert">€123.45m</span></div>')
    const r = await svc.getTeamValue('test', 999000)
    expect(r.value).toBe(123450000)
  })

  it('parse les milliards', async () => {
    withPage('<div><span class="marktwert">€1.50bn</span></div>')
    const r = await svc.getTeamValue('test', 999001)
    expect(r.value).toBe(1500000000)
  })

  it('rend null sans widget (pas d invention)', async () => {
    withPage('<div><span class="autre">x</span></div>')
    const r = await svc.getTeamValue('test', 999002)
    expect(r.value).toBeNull()
  })

  it('lit le nouveau markup market-value-wrapper (ex. Raja)', async () => {
    withPage('<a class="data-header__market-value-wrapper"><span>€</span>15.82<span>m</span><p>Total market value</p></a>')
    const r = await svc.getTeamValue('raja-casablanca', 2068)
    expect(r.value).toBe(15820000)
  })
})

describe('parseMarketValue (E121)', () => {
  it('gere m, k, bn, Mrd', () => {
    expect(parseMarketValue('€123.45m')).toBe(123450000)
    expect(parseMarketValue('€1.50bn')).toBe(1500000000)
    expect(parseMarketValue('€2,30Mrd')).toBe(2300000000)
    expect(parseMarketValue('€550k')).toBe(550000)
    expect(parseMarketValue('€15.82m')).toBe(15820000)
  })

  it('rend null si illisible', () => {
    expect(parseMarketValue('')).toBeNull()
    expect(parseMarketValue('N/A')).toBeNull()
    expect(parseMarketValue('€12xyz')).toBeNull()
  })
})
