/**
 * E118 — le tracker incluait `matches` uniquement (0 ligne notee) :
 * l'onglet "Precision par ligue" etait toujours vide.
 */
const { aggregateTracker } = require('../routes/analytics')

const row = (league, ph, pd, pa, sh, sa) => ({
  id: 1, homeTeam: 'H', awayTeam: 'A', league,
  scoreHome: sh, scoreAway: sa,
  home_win_probability: ph, draw_probability: pd, away_win_probability: pa,
  prediction: null, confidence: 70, expected_score: null,
})

describe('aggregateTracker (E118)', () => {
  it('compte juste/faux global + par ligue, trie par volume', () => {
    const out = aggregateTracker([
      row('Ligue 1', 60, 25, 15, 2, 0), // H juste
      row('Ligue 1', 60, 25, 15, 0, 1), // H faux
      row('Botola', 30, 30, 40, 0, 2), // A juste
    ])
    expect(out.success).toBe(true)
    expect(out.total).toBe(3)
    expect(out.correct).toBe(2)
    expect(out.wrong).toBe(1)
    expect(out.winRate).toBe(67)
    expect(out.leagues[0].league).toBe('Ligue 1')
    expect(out.leagues[0]).toMatchObject({ correct: 1, wrong: 1, total: 2, winRate: 50 })
    expect(out.leagues[1]).toMatchObject({ league: 'Botola', correct: 1, total: 1, winRate: 100 })
  })

  it('est insensible a l echelle des probas (0-1 comme 0-100)', () => {
    const a = aggregateTracker([row('X', 0.6, 0.25, 0.15, 2, 0)])
    const b = aggregateTracker([row('X', 60, 25, 15, 2, 0)])
    expect(a).toEqual(b)
  })

  it('ignore les lignes sans signal (max 0)', () => {
    const out = aggregateTracker([row('X', 0, 0, 0, 2, 0)])
    expect(out.total).toBe(0)
    expect(out.leagues).toEqual([])
  })

  it('nul predit et realise compte juste', () => {
    const out = aggregateTracker([row('X', 30, 45, 25, 1, 1)])
    expect(out.correct).toBe(1)
  })
})
