/**
 * Verrou de contrat — empreinte par ligue (E22).
 * La voie de calibration ne doit plus re-joindre les metriques a la liste de
 * resultats par egalite flottante de probabilites (bug qui recreait un bucket
 * 'Unknown' et collait deux ligues differentes aux memes probs). Chaque metrique
 * porte sa propre ligue desormais. Fonctions pures -> zero ecriture disque.
 */
const { computeCalibrationMetrics, _aggregateCalibrationByLeague } = require('../services/autoBacktestService')

const mkMatch = (over = {}) => ({
  id: 'm1',
  league: 'Premier League',
  homeTeam: 'A',
  awayTeam: 'B',
  scoreHome: 2,
  scoreAway: 1,
  home_win_probability: 60,
  draw_probability: 25,
  away_win_probability: 15,
  ou_25_prob: 55,
  btts_prob: 50,
  ...over,
})

describe('computeCalibrationMetrics — porte sa ligue', () => {
  test('retourne league + matchId depuis match.league', () => {
    const cm = computeCalibrationMetrics(mkMatch({ id: 'x', league: 'LaLiga' }))
    expect(cm.league).toBe('LaLiga')
    expect(cm.matchId).toBe('x')
  })

  test('repli tournament_name puis Unknown', () => {
    expect(computeCalibrationMetrics(mkMatch({ league: undefined, tournament_name: 'Serie A' })).league).toBe('Serie A')
    expect(computeCalibrationMetrics(mkMatch({ league: undefined, tournament_name: undefined })).league).toBe('Unknown')
  })

  test('null si score absent (garde preexistante intacte)', () => {
    expect(computeCalibrationMetrics({ home_win_probability: 60 })).toBeNull()
  })
})

describe('_aggregateCalibrationByLeague — plus de collision ni Unknown fantome', () => {
  test('deux ligues aux PROBABILITES IDENTIQUES restent separees (regression du join)', () => {
    const cms = [
      computeCalibrationMetrics(mkMatch({ id: 'p1', league: 'Premier League' })),
      computeCalibrationMetrics(mkMatch({ id: 's1', league: 'LaLiga' })),
    ].filter(Boolean)
    const byLg = _aggregateCalibrationByLeague(cms)
    expect(Object.keys(byLg).sort()).toEqual(['LaLiga', 'Premier League'])
    expect(byLg['Premier League'].brier1x2).toHaveLength(1)
    expect(byLg.LaLiga.brier1x2).toHaveLength(1)
    expect(byLg.Unknown).toBeUndefined()
  })

  test('cumule les matchs d une meme ligue', () => {
    const cms = [
      computeCalibrationMetrics(mkMatch({ id: 'a', league: 'Bundesliga' })),
      computeCalibrationMetrics(mkMatch({ id: 'b', league: 'Bundesliga' })),
    ].filter(Boolean)
    expect(_aggregateCalibrationByLeague(cms).Bundesliga.brier1x2).toHaveLength(2)
  })

  test('cm sans ligue -> Unknown (seul cas legitime)', () => {
    const byLg = _aggregateCalibrationByLeague([{ brier1x2: 0.1, logloss1x2: 0.3, brierOU: 0.2, loglossOU: 0.5, brierBTTS: 0.2, loglossBTTS: 0.5 }])
    expect(Object.keys(byLg)).toEqual(['Unknown'])
    expect(byLg.Unknown.brier1x2).toHaveLength(1)
  })

  test('liste vide -> objet vide', () => {
    expect(_aggregateCalibrationByLeague([])).toEqual({})
    expect(_aggregateCalibrationByLeague(null)).toEqual({})
  })
})
