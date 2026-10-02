/**
 * integrityScorer.test.js — tests du score d'intégrité a posteriori (E70).
 * Aucun accès réseau ni DB : on teste le service pur sur des matchs synthétiques.
 */
jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

const { scoreMatch, _verdict, VERDICT_NO_DATA } = require('../services/integrityScorer')

// Match "normal" : le favori gagne, le xG colle au score, cotes de marché cohérentes.
const cleanMatch = () => ({
  id: 'm1',
  homeTeam: 'Alpha',
  awayTeam: 'Beta',
  league: 'Premier League',
  scoreHome: 2,
  scoreAway: 1,
  home_xg: 1.8,
  away_xg: 0.9,
  odds_home: 1.75,
  odds_draw: 3.8,
  odds_away: 4.2,
  odds_home_open: 1.9,
  odds_source: 'betexplorer',
})

describe('_verdict', () => {
  test('classe selon les seuils', () => {
    expect(_verdict(0)).toBe('NORMAL')
    expect(_verdict(24)).toBe('NORMAL')
    expect(_verdict(25)).toBe('A_SURVEILLER')
    expect(_verdict(49)).toBe('A_SURVEILLER')
    expect(_verdict(50)).toBe('SUSPECT')
    expect(_verdict(74)).toBe('SUSPECT')
    expect(_verdict(75)).toBe('HAUTEMENT_SUSPECT')
    expect(_verdict(500)).toBe('HAUTEMENT_SUSPECT')
  })
})

describe('couverture des données', () => {
  test('match sans aucune donnée exploitable => DONNEE_INSUFFISANTE (pas NORMAL)', () => {
    const res = scoreMatch({ id: 'empty', scoreHome: 1, scoreAway: 0 })
    expect(res.verdict).toBe(VERDICT_NO_DATA)
    expect(res.assessable).toBe(false)
    expect(res.fixing_score).toBe(0)
  })

  test('xG hors bornes plausibles => neutralisé', () => {
    const res = scoreMatch({
      id: 'corrupt',
      scoreHome: 0,
      scoreAway: 4,
      home_xg: 141905054.19, // valeur corrompue observée en base
      away_xg: 0.25,
      odds_home: 1.5,
      odds_away: 6,
      odds_source: 'betexplorer',
    })
    expect(res.coverage).not.toContain('XG')
    expect(res.flags).not.toContain('XG_BETRAYAL')
  })

  test('lit les xG depuis fullData string', () => {
    const res = scoreMatch({
      id: 'fd',
      scoreHome: 0,
      scoreAway: 3,
      odds_home: 1.4,
      odds_away: 7,
      odds_source: 'oddsportal',
      fullData: JSON.stringify({ home_xg: 2.5, away_xg: 0.4 }),
    })
    expect(res.coverage).toContain('XG')
    expect(res.flags).toContain('XG_BETRAYAL')
  })
})

describe('XG_BETRAYAL', () => {
  test('le perdant domine au xG et perd de 2+ buts', () => {
    const res = scoreMatch({
      id: 'betray',
      scoreHome: 0,
      scoreAway: 2,
      home_xg: 2.1, // le perdant a mieux produIt
      away_xg: 1.0,
      odds_home: 1.6,
      odds_away: 5.5,
      odds_source: 'betexplorer',
    })
    expect(res.flags).toContain('XG_BETRAYAL')
    expect(res.fixing_score).toBeGreaterThanOrEqual(25)
  })

  test('ne se déclenche pas si le perdant n’a pas dominé', () => {
    const res = scoreMatch({
      id: 'no-betray',
      scoreHome: 0,
      scoreAway: 2,
      home_xg: 0.4,
      away_xg: 1.6,
      odds_home: 4,
      odds_away: 1.7,
      odds_source: 'betexplorer',
    })
    expect(res.flags).not.toContain('XG_BETRAYAL')
  })

  test('marge d’un seul but : pas de trahison xG', () => {
    const res = scoreMatch({
      id: 'one-goal',
      scoreHome: 0,
      scoreAway: 1,
      home_xg: 2.2,
      away_xg: 0.5,
      odds_home: 2.2,
      odds_away: 3.4,
      odds_source: 'betexplorer',
    })
    expect(res.flags).not.toContain('XG_BETRAYAL')
  })
})

describe('signaux de marché', () => {
  test('LONGSHOT_WINNER avec cote marché > 5.0', () => {
    const res = scoreMatch({
      id: 'shot',
      scoreHome: 0,
      scoreAway: 1, // l'équipe extérieure, outsider à 6.5, gagne
      away_xg: 1.2,
      home_xg: 0.8,
      odds_home: 1.5,
      odds_away: 6.5,
      odds_source: 'flashscore',
    })
    expect(res.flags).toContain('LONGSHOT_WINNER')
  })

  test('cote synthétique REJETÉE (raisonnement circulaire)', () => {
    // Même match que le test LONGSHOT_WINNER (horsieur à 6.5 qui gagne) mais la
    // cote vient de NOTRE modèle : le signal ne doit surtout PAS se déclencher.
    for (const src of ['synthetic', 'fair_odds_model', 'model_league', '']) {
      const res = scoreMatch({
        id: 'circ-' + (src || 'none'),
        scoreHome: 0,
        scoreAway: 1,
        away_xg: 1.2,
        home_xg: 0.8,
        odds_home: 1.5,
        odds_away: 6.5,
        odds_source: src,
      })
      expect(res.flags).not.toContain('LONGSHOT_WINNER')
    }
  })

  test('STEAM_VINDICATED sur chute > 25% du vainqueur', () => {
    const res = scoreMatch({
      id: 'steam',
      scoreHome: 2,
      scoreAway: 0,
      home_xg: 1.6,
      away_xg: 0.7,
      odds_home: 3.0,
      odds_home_open: 6.0, // -50%
      odds_away: 4.0,
      odds_source: 'oddsportal',
    })
    expect(res.flags).toContain('STEAM_VINDICATED')
  })

  test('bruit de marché normal : aucun signal', () => {
    const res = scoreMatch(cleanMatch())
    expect(res.flags).not.toContain('STEAM_VINDICATED')
    expect(res.verdict).toBe('NORMAL')
    expect(res.fixing_score).toBe(0)
  })
})

describe('incidents', () => {
  test('but précoce + own goal => 2 sous-flags, plafond 30 pts', () => {
    const res = scoreMatch({
      id: 'inc',
      scoreHome: 0,
      scoreAway: 2,
      away_xg: 1.1,
      home_xg: 0.6,
      odds_home: 5,
      odds_away: 1.8,
      odds_source: 'betexplorer',
      fullData: {
        incidents: [
          { time: '3', type: 'goal', incidentClass: 'regular', isHome: false, text: 'Goal' },
          { time: '30', type: 'goal', incidentClass: 'own goal', isHome: true, text: 'Own goal' },
        ],
      },
    })
    expect(res.flags).toContain('ANOMALOUS_INCIDENT')
    expect(res.flags).toContain('EARLY_GOAL')
    expect(res.flags).toContain('OWN_GOAL')
    const sig = res.signals.find((s) => s.flag === 'ANOMALOUS_INCIDENT')
    expect(sig.weight).toBe(30)
  })

  test('carton rouge avant la 20e', () => {
    const res = scoreMatch({
      id: 'red',
      scoreHome: 1,
      scoreAway: 0,
      home_xg: 1.0,
      away_xg: 1.4,
      odds_home: 2.4,
      odds_away: 2.8,
      odds_source: 'betexplorer',
      fullData: { incidents: [{ time: '12', type: 'card', incidentClass: 'red', text: 'Red card' }] },
    })
    expect(res.flags).toContain('EARLY_RED')
  })

  test('penalty décisif sur un écart d’un but', () => {
    const res = scoreMatch({
      id: 'pen',
      scoreHome: 1,
      scoreAway: 0,
      home_xg: 1.0,
      away_xg: 0.9,
      odds_home: 2.2,
      odds_away: 3.1,
      odds_source: 'betexplorer',
      fullData: { incidents: [{ time: '70', type: 'goal', incidentClass: 'penalty', text: 'Penalty' }] },
    })
    expect(res.flags).toContain('DECISIVE_PENALTY')
  })
})

describe('contexte', () => {
  test('FAVORITE_COLLAPSE disjoint de XG_BETRAYAL', () => {
    // favori battu de 3 buts mais SANS domination xG (ratio < 1.5)
    const res = scoreMatch({
      id: 'collapse',
      scoreHome: 0,
      scoreAway: 3,
      home_xg: 1.3, // ratio 1.3 / 1.2 = 1.08 < 1.5
      away_xg: 1.2,
      odds_home: 1.6,
      odds_away: 5.5,
      odds_source: 'betexplorer',
    })
    expect(res.flags).toContain('FAVORITE_COLLAPSE')
    expect(res.flags).not.toContain('XG_BETRAYAL')
  })

  test('zone morte : +10 seulement', () => {
    const res = scoreMatch({ ...cleanMatch(), motivation_signature: 'ZONE_MORTE' })
    expect(res.flags).toContain('DEAD_ZONE_CONTEXT')
    expect(res.fixing_score).toBe(10)
    // 10 < 25 : reste sous le seuil de surveillance
    expect(res.verdict).toBe('NORMAL')
  })

  test('COMPLAISANCE : +30', () => {
    const res = scoreMatch({ ...cleanMatch(), motivation_signature: 'COMPLAISANCE' })
    expect(res.flags).toContain('COMPLAISANCE')
    expect(res.fixing_score).toBe(30)
  })
})

describe('plafond de confiance (faux positifs)', () => {
  test('coupe à effectif rotatif : verdict jamais SUSPECT', () => {
    const res = scoreMatch({
      id: 'cup',
      league: "Emperor's Cup",
      scoreHome: 0,
      scoreAway: 9,
      home_xg: 1.84,
      away_xg: 1.2,
      odds_home: 4,
      odds_away: 1.6,
      odds_source: 'betexplorer',
    })
    expect(res.fixing_score).toBeGreaterThanOrEqual(50)
    expect(res.low_confidence).toBe(true)
    expect(res.flags).toContain('CONFIANCE_FAIBLE')
    expect(res.verdict).toBe('A_SURVEILLER')
  })

  test('score extrême hors coupe : même traitement', () => {
    const res = scoreMatch({
      id: 'chaos',
      league: 'Serie A',
      scoreHome: 0,
      scoreAway: 6,
      home_xg: 1.0,
      away_xg: 1.4,
      odds_home: 3,
      odds_away: 2.2,
      odds_source: 'betexplorer',
    })
    expect(res.low_confidence).toBe(true)
    expect(res.verdict).not.toBe('SUSPECT')
  })

  test('match de championnat cohérent : pas de plafond', () => {
    const res = scoreMatch({
      id: 'serie',
      league: 'Serie A',
      scoreHome: 0,
      scoreAway: 3,
      home_xg: 2.13,
      away_xg: 1.11,
      odds_home: 1.5,
      odds_away: 5.25,
      odds_source: 'betexplorer',
    })
    expect(res.low_confidence).toBe(false)
    expect(res.verdict).toBe('SUSPECT')
  })
})

describe('robustesse', () => {
  test('match null ne lève pas', () => {
    const res = scoreMatch(null)
    expect(res.fixing_score).toBe(0)
    expect(res.verdict).toBe(VERDICT_NO_DATA)
  })

  test('fullData corrompu ne lève pas', () => {
    const res = scoreMatch({ id: 'broken', scoreHome: 1, scoreAway: 0, fullData: '{pas du json' })
    expect(res.assessable).toBe(false)
  })

  test('score toujours borné 0..100', () => {
    const res = scoreMatch({
      id: 'max',
      league: 'Serie A',
      scoreHome: 0,
      scoreAway: 3,
      home_xg: 2.13,
      away_xg: 1.11,
      odds_home: 1.5,
      odds_away: 6.5,
      odds_home_open: 9.0,
      odds_source: 'betexplorer',
      motivation_signature: 'COMPLAISANCE',
      fullData: {
        incidents: [
          { time: '2', type: 'goal', incidentClass: 'regular', text: 'Goal' },
          { time: '5', type: 'goal', incidentClass: 'own goal', text: 'Own goal' },
        ],
      },
    })
    expect(res.fixing_score).toBeLessThanOrEqual(100)
    expect(res.fixing_score).toBeGreaterThanOrEqual(0)
  })
})
