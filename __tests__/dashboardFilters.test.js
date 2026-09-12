/**
 * Tests dashboardFilters.js — corrections E18 du Dashboard :
 * filtre ligue (enfin appliqué), compteurs d'onglets stables, recherche
 * insensible aux accents des deux côtés, cohérence filtres/compteurs.
 */
const {
  norm,
  searchMatches,
  leagueMatches,
  leagueKeywords,
  toRawLines,
  hasMarketPrediction,
  computeChipCounts,
  applyBaseFilters,
  applyMarketFilter,
} = require('../src/utils/dashboardFilters')

const mkMatch = (over = {}) => ({
  id: 'm-' + Math.random().toString(36).slice(2),
  homeTeam: 'Home',
  awayTeam: 'Away',
  league: '3. Liga',
  status: 'scheduled',
  startTimestamp: 1750000000,
  odds_home: '2.10',
  odds_draw: '3.40',
  odds_away: '3.50',
  odds_over25: '1.85',
  odds_under25: '1.95',
  odds_btts_yes: '1.75',
  odds_btts_no: '2.05',
  home_win_probability: 60,
  draw_probability: 22,
  away_win_probability: 18,
  confidence: 72,
  btts_prob: 62,
  ou_25_prob: 56,
  ht_goal_prob: 74,
  insufficient_data: 0,
  enriched: {},
  quant: {},
  ...over,
})

describe('norm', () => {
  it('lowercase + accents retirés', () => {
    expect(norm('Atlético Madrid')).toBe('atletico madrid')
    expect(norm(null)).toBe('')
  })
})

describe('searchMatches', () => {
  it('équipes et ligue, insensible accents/casse', () => {
    const m = mkMatch({ homeTeam: 'Atlético', awayTeam: 'Bayer', league: 'LaLiga' })
    expect(searchMatches(m, 'atletico')).toBe(true)
    expect(searchMatches(m, 'BAYE')).toBe(true)
    expect(searchMatches(m, 'laliga')).toBe(true)
    expect(searchMatches(m, 'barca')).toBe(false)
    expect(searchMatches(m, '')).toBe(true)
  })
})

describe('leagueMatches (filtre ligue, corrigé E18)', () => {
  it('ALL / vide = passepartout', () => {
    expect(leagueMatches(mkMatch(), 'ALL')).toBe(true)
    expect(leagueMatches(mkMatch(), null)).toBe(true)
  })

  it('sélection épinglée résolue par TOUTES ses keywords', () => {
    expect(leagueMatches(mkMatch({ league: 'England : Premier League' }), 'premier league')).toBe(true)
    expect(leagueMatches(mkMatch({ league: 'EPL U21' }), 'premier league')).toBe(true) // keyword 'epl'
    expect(leagueMatches(mkMatch({ league: 'Bundesliga' }), 'premier league')).toBe(false)
  })

  it('LaLiga casse/accents', () => {
    expect(leagueMatches(mkMatch({ league: 'Espagne : LaLiga' }), 'LaLiga')).toBe(true)
    expect(leagueMatches(mkMatch({ league: 'La Liga' }), 'laliga')).toBe(true)
  })

  it('ligue dynamique : sélection = nom brut', () => {
    expect(leagueMatches(mkMatch({ league: 'Esiliiga' }), 'Esiliiga')).toBe(true)
    expect(leagueMatches(mkMatch({ league: 'Esiliiga' }), 'Norwegian Premier League')).toBe(false)
  })

  it('match sans ligue filtré quand sélection active', () => {
    expect(leagueMatches(mkMatch({ league: '' }), 'champions league')).toBe(false)
  })

  it('MENA : keywords[0] sélectionné résout le groupe de keywords', () => {
    expect(leagueKeywords('botola')).toContain('morocco')
    expect(leagueMatches(mkMatch({ league: 'Morocco - Botola Pro' }), 'botola')).toBe(true)
  })
})

describe('toRawLines (cache)', () => {
  it('mémoïse par référence objet', () => {
    const m = mkMatch()
    expect(toRawLines(m)).toBe(toRawLines(m))
  })
})

describe('compteurs d’onglets + filtres marché', () => {
  const list = [
    mkMatch(),
    mkMatch({ home_win_probability: 40, away_win_probability: 35, draw_probability: 25 }),
    mkMatch({ btts_prob: 71, ou_25_prob: 44, home_win_probability: 48, away_win_probability: 30, draw_probability: 22 }),
  ]

  it('hasMarketPrediction applique les seuils par marché', () => {
    // NB (comportement vérifié) : avec cotes réelles présentes, la cellule
    // vainqueur suit la proba MARCHÉ dévigguée (1.35 -> ~69%), pas la proba
    // brute du modèle. Sans cotes, fallback sur la proba du modèle.
    const strong = toRawLines(mkMatch({ odds_home: '1.35', odds_draw: '4.80', odds_away: '8.00' }))
    expect(hasMarketPrediction(strong, 'win')).toBe(true)
    const weak = toRawLines(mkMatch({ odds_home: '2.90', odds_draw: '3.20', odds_away: '2.50' }))
    expect(hasMarketPrediction(weak, 'win')).toBe(false)
  })

  it('computeChipCounts cohérent avec applyMarketFilter', () => {
    const counts = computeChipCounts(list)
    for (const tab of ['ou', 'win', 'btts', 'ht', 'corners']) {
      expect(counts[tab] || 0).toBe(applyMarketFilter(list, tab).length)
    }
  })

  it('compteurs FIXES quand un onglet est actif (bug E18)', () => {
    const countsAvant = computeChipCounts(list)
    const apresFiltre = applyMarketFilter(list, 'win')
    const countsApres = computeChipCounts(list) // toujours sur la base, pas le sous-ensemble
    expect(countsApres).toEqual(countsAvant)
    expect(apresFiltre.length).toBeLessThanOrEqual(countsAvant.win || 0)
  })

  it('applyBaseFilters combine recherche + ligue', () => {
    const base = applyBaseFilters(list, { searchQuery: 'Home', activeLeague: 'ALL' })
    expect(base.length).toBe(list.length)
    const none = applyBaseFilters(list, { searchQuery: 'zzz', activeLeague: 'ALL' })
    expect(none.length).toBe(0)
    const ligue = applyBaseFilters(list, { searchQuery: '', activeLeague: 'premier league' })
    expect(ligue.length).toBe(0)
  })
})
