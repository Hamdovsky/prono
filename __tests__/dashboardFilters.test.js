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
  parseFilterSearch,
  buildFilterSearch,
  leagueDisplayLabel,
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

describe('filtres <-> URL (E19)', () => {
  it('aller-retour complet avec tous les filtres', () => {
    const state = {
      activeLeague: 'premier league',
      activeDate: 'Next 3 Days',
      dominantFilter: 'ou',
      searchQuery: 'arsenal',
      onlyRealOdds: true,
      hideNoBet: true,
      onlyFavorites: true,
      matchId: '15353112',
    }
    const qs = buildFilterSearch(state)
    expect(qs.startsWith('?')).toBe(true)
    expect(parseFilterSearch(qs)).toEqual(state)
  })

  it('aucun filtre actif -> querystring vide -> parse aux valeurs par défaut', () => {
    expect(buildFilterSearch({})).toBe('')
    expect(parseFilterSearch('')).toEqual({
      activeLeague: 'ALL',
      activeDate: 'Today',
      dominantFilter: 'ALL',
      searchQuery: '',
      onlyRealOdds: false,
      hideNoBet: false,
      onlyFavorites: false,
      matchId: null,
    })
  })

  it('valeurs invalides rejetées silencieusement (URL manuellement éditée)', () => {
    const p = parseFilterSearch('?date=Blah&marche=hack&ligue=%20x')
    expect(p.activeDate).toBe('Today')
    expect(p.dominantFilter).toBe('ALL')
    expect(p.activeLeague).toBe(' x') // ligues = chaîne libre, trim via norm
  })

  it('recherche avec accents/espaces survit à lencodage', () => {
    const qs = buildFilterSearch({ searchQuery: 'Atlético Madrid' })
    expect(parseFilterSearch(qs).searchQuery).toBe('Atlético Madrid')
  })

  it('leagueDisplayLabel nomme joliment les selections epinglees', () => {
    expect(leagueDisplayLabel('premier league')).toBe('Angleterre : Premier League')
    expect(leagueDisplayLabel('botola')).toBe('Maroc : Botola Pro')
    expect(leagueDisplayLabel('Esiliiga')).toBe('Esiliiga') // ligue dynamique inchangee
  })
})

describe('filtres qualite (E20-B)', () => {
  const mk = require('../src/utils/dashboardFilters')
  const withOdds = mkMatch({ odds_home: '1.9', odds_draw: '3.5', odds_away: '3.9' })
  const noOdds = mkMatch({ odds_home: null, odds_draw: null, odds_away: null })
  const vetoed = mkMatch({ market_divergence: { flagged: true, edge_pp: 15 } })
  const noBetVerdict = mkMatch({ verdict: 'NO BET (DIVERGENCE MARCHE)' })
  const clean = mkMatch({ verdict: 'SAFE', market_divergence: { flagged: false } })

  it('hasRealOdds exige les 3 cotes > 1', () => {
    expect(mk.hasRealOdds(withOdds)).toBe(true)
    expect(mk.hasRealOdds(noOdds)).toBe(false)
    expect(mk.hasRealOdds(mkMatch({ odds_draw: '1.0' }))).toBe(false)
  })

  it('hasVeto detecte divergence signalee, verdict et status NO BET', () => {
    expect(mk.hasVeto(vetoed)).toBe(true)
    expect(mk.hasVeto(noBetVerdict)).toBe(true)
    expect(mk.hasVeto(mkMatch({ status: 'NO_BET_OVERCONFIDENT' }))).toBe(true)
    expect(mk.hasVeto(clean)).toBe(false)
  })

  it('applyQualityFilters combine les deux toggles', () => {
    const list = [withOdds, noOdds, vetoed, clean]
    expect(mk.applyQualityFilters(list, {}).length).toBe(4)
    expect(mk.applyQualityFilters(list, { onlyRealOdds: true }).length).toBe(3)
    expect(mk.applyQualityFilters(list, { hideNoBet: true }).length).toBe(3) // vetoed seul exclu
    expect(
      mk.applyQualityFilters(list, { onlyRealOdds: true, hideNoBet: true }).map((m) => m.id)
    ).toEqual([withOdds.id, clean.id])
  })
})

describe('stats de la vue + CSV + favoris (E21)', () => {
  const { computeQualitySummary, buildCsv, CSV_HEADER } = require('../src/utils/dashboardFilters')

  const withOdds = mkMatch({ odds_home: '1.9', odds_draw: '3.5', odds_away: '3.9' })
  const noOdds = mkMatch({ odds_home: null, odds_draw: null, odds_away: null })
  const vetoed = mkMatch({ market_divergence: { flagged: true } })
  const cac = mkMatch({ contextual: { enabled: true, cac_home: 0.91, cac_away: 1.04 } })

  it('computeQualitySummary compte chaque dimension', () => {
    expect(computeQualitySummary([withOdds, noOdds, vetoed, cac])).toEqual({
      total: 4,
      realOdds: 3,
      vetoed: 1,
      cacApplied: 1,
    })
    expect(computeQualitySummary([])).toEqual({ total: 0, realOdds: 0, vetoed: 0, cacApplied: 0 })
    expect(computeQualitySummary(null).total).toBe(0)
  })

  it('buildCsv: en-tete, une ligne par match, echappement', () => {
    const lines = buildCsv([withOdds]).split('\r\n')
    expect(lines[0]).toBe(CSV_HEADER.join(';'))
    expect(lines.length).toBe(2)
    expect(lines[1]).toContain('3. Liga')
    expect(lines[1]).toContain('1.9')
    const tricky = buildCsv([mkMatch({ league: 'Liga; "Spa"' })]).split('\r\n')[1]
    expect(tricky.startsWith('"Liga; ""Spa"""')).toBe(true)
  })

  it('buildCsv survit a un element null', () => {
    expect(buildCsv([withOdds, null]).split('\r\n').length).toBe(3)
  })

  it('applyBaseFilters avec favoris (E21-B)', () => {
    const a = mkMatch({ homeTeam: 'Paris FC', awayTeam: 'Lyon' })
    const b = mkMatch({ homeTeam: 'Nice', awayTeam: 'Marseille' })
    const base = { searchQuery: '', activeLeague: 'ALL' }
    expect(applyBaseFilters([a, b], base).length).toBe(2)
    expect(applyBaseFilters([a, b], { ...base, onlyFavorites: true, favorites: ['LYON'] })).toEqual([a])
    expect(applyBaseFilters([a, b], { ...base, onlyFavorites: true, favorites: [] }).length).toBe(0)
  })
})
