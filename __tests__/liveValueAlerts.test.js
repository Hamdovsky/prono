/**
 * E92 — live_value_alerts route désormais par le bypass SofaScore (curl_cffi).
 * L'adaptateur toSofaShape convertit la forme plate du bypass vers la forme
 * imbriquée historique attendue par le moteur d'alertes.
 */
const { toSofaShape } = require('../scripts/live_value_alerts')

describe('toSofaShape (E92)', () => {
  it('mappe un event bypass complet vers la forme SofaScore imbriquée', () => {
    const out = toSofaShape({
      id: 123,
      homeTeam: 'HB Koege',
      awayTeam: 'AB',
      tournament: 'Danmarksserien',
      homeScore: 1,
      awayScore: 0,
      minute: "34'",
      liveMinute: 34.2,
      statusType: 'inprogress',
      odds: { home: 1.85, away: 4.2 },
    })

    expect(out.id).toBe(123)
    expect(out.homeTeam).toEqual({ name: 'HB Koege' })
    expect(out.awayTeam).toEqual({ name: 'AB' })
    expect(out.tournament).toEqual({ name: 'Danmarksserien' })
    expect(out.homeScore).toEqual({ display: 1, current: 1 })
    expect(out.awayScore).toEqual({ display: 0, current: 0 })
    expect(out.status).toEqual({ type: 'inprogress', description: "34'" })
    expect(out.odds).toEqual({ home: 1.85, away: 4.2 })
  })

  it('dérive la description-minute depuis liveMinute si minute est absent', () => {
    const out = toSofaShape({ id: 1, homeScore: 0, awayScore: 0, liveMinute: 67.9 })
    expect(out.status.description).toBe("67'")
    const m = out.status.description.match(/(\d+)/)
    expect(parseInt(m[1])).toBe(67)
  })

  it('tolère des scores nuls et une minute absente', () => {
    const out = toSofaShape({ id: 2, homeScore: null, awayScore: null })
    expect(out.homeScore).toEqual({ display: null, current: null })
    expect(out.awayScore).toEqual({ display: null, current: null })
    expect(out.status.description).toBe('')
    expect(out.odds).toEqual({})
  })
})
