const { computeAbsenceImpact } = require('../services/scrapers/SofascoreBypass')

describe('Phase 9 — computeAbsenceImpact', () => {
  test('GK blessé à domicile pèse plus qu\'une doublure incertaine', () => {
    const items = [
      { team: 'Chelsea', player: 'Kepa', position: 'G', status: 'injured' },
      { team: 'Chelsea', player: 'Bench', position: 'M', status: 'doubtful' },
    ]
    const r = computeAbsenceImpact(items, 'Chelsea', 'Arsenal')
    expect(r.home).toBeGreaterThan(0)
    expect(r.away).toBe(0)
    expect(r.home).toBeLessThanOrEqual(1)
  })

  test('absence côté adverse uniquement', () => {
    const items = [{ team: 'Arsenal', player: 'Saka', position: 'F', status: 'suspended' }]
    const r = computeAbsenceImpact(items, 'Chelsea', 'Arsenal')
    expect(r.away).toBeGreaterThan(0)
    expect(r.home).toBe(0)
  })

  test('aucune absence connue -> impact 0', () => {
    const r = computeAbsenceImpact([], 'Chelsea', 'Arsenal')
    expect(r).toEqual({ home: 0, away: 0 })
  })

  test('normalisation : saturation à 1.0', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      team: 'Chelsea', player: 'P' + i, position: 'F', status: 'injured',
    }))
    const r = computeAbsenceImpact(items, 'Chelsea', 'Arsenal')
    expect(r.home).toBe(1)
  })
})
