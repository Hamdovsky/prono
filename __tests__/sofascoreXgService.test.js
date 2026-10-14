/**
 * E90 — sofascoreXgService routé via SofascoreBypass (curl_cffi).
 * Le fetch Node direct renvoie 403 ; le service lit expectedGoalsHome/Away
 * exposés par le pont Python (scripts/sofascore_bypass.py `stats`).
 */
jest.mock('../services/scrapers/SofascoreBypass', () => ({
  getEventStats: jest.fn(),
}))

const bypass = require('../services/scrapers/SofascoreBypass')
const svc = require('../services/sofascoreXgService')

describe('sofascoreXgService (via SofascoreBypass)', () => {
  beforeEach(() => {
    bypass.getEventStats.mockReset()
  })

  it('mappe expectedGoalsHome/Away -> home_xg/away_xg', async () => {
    bypass.getEventStats.mockResolvedValue({
      found: true,
      expectedGoalsHome: 1.55,
      expectedGoalsAway: 1.37,
    })
    const r = await svc.fetchMatchXg(11366885)
    expect(r).toEqual({ home_xg: 1.55, away_xg: 1.37, source: 'SOFASCORE' })
    expect(bypass.getEventStats).toHaveBeenCalledWith(11366885)
  })

  it('coerce les valeurs textuelles', async () => {
    bypass.getEventStats.mockResolvedValue({
      found: true,
      expectedGoalsHome: '1.10',
      expectedGoalsAway: '0.90',
    })
    const r = await svc.fetchMatchXg(2001)
    expect(r.home_xg).toBeCloseTo(1.1, 2)
    expect(r.away_xg).toBeCloseTo(0.9, 2)
  })

  it('retourne null si le payload n a pas de xG', async () => {
    bypass.getEventStats.mockResolvedValue({ found: true, c_ft_h: 8, c_ft_a: 4 })
    expect(await svc.fetchMatchXg(2002)).toBeNull()
  })

  it('retourne null si stats introuvables', async () => {
    bypass.getEventStats.mockResolvedValue(null)
    expect(await svc.fetchMatchXg(2003)).toBeNull()
  })

  it('retourne null sans sofascoreId (sans appel)', async () => {
    expect(await svc.fetchMatchXg(null)).toBeNull()
    expect(bypass.getEventStats).not.toHaveBeenCalled()
  })

  it('met en cache le resultat', async () => {
    bypass.getEventStats.mockResolvedValue({
      found: true,
      expectedGoalsHome: 2.0,
      expectedGoalsAway: 0.8,
    })
    const a = await svc.fetchMatchXg(2004)
    const b = await svc.fetchMatchXg(2004)
    expect(a).toEqual(b)
    expect(bypass.getEventStats).toHaveBeenCalledTimes(1)
  })
})
