/**
 * E93 — Affichage du combo GG + Over 2.5 côté dashboard.
 * Couvre : cellule brute index 21, marketBannerFromLines('combo'),
 * colonne COMBO (tableColumns), onglet/filtre/counts (dashboardFilters).
 */
const { computeRawLines, analyzeMatch, marketBannerFromLines } = require('../src/utils/matchAnalysis.js')
const {
  toRawLines,
  marketPct,
  hasMarketPrediction,
  MARKET_MIN_PCT,
  MARKET_TABS,
  VALID_MARKETS,
  computeChipCounts,
  applyMarketFilter,
} = require('../src/utils/dashboardFilters.js')
const { columnsForWidth, TABLE_COLUMNS } = require('../src/utils/tableColumns.js')

const matchWith = (over25) => ({
  id: 'c1',
  homeTeam: 'Paris SG',
  awayTeam: 'Marseille',
  league: 'Ligue 1',
  status: 'scheduled',
  startTimestamp: 1750000000,
  odds_home: '1.60',
  odds_draw: '4.00',
  odds_away: '5.50',
  home_win_probability: 60,
  draw_probability: 22,
  away_win_probability: 18,
  btts_prob: 62,
  ou_25_prob: 64,
  insufficient_data: 0,
  enriched: {},
  quant: { probs: { btts: 62, over25: 64, btts_over25: over25 } },
})

describe('combo — matchAnalysis', () => {
  it('expose out.combo et la cellule index 21 depuis quant.probs.btts_over25', () => {
    const m = matchWith(48)
    const a = analyzeMatch(m)
    expect(a.combo).toEqual({ label: 'GG+O2.5 48%', pct: 48, verdict: 'NON' })
    const r = computeRawLines(m)
    expect(r.length).toBe(22)
    expect(r[21]).toBe('GG+O2.5 48%')
  })

  it('accepte le fallback persisté btts_over25_prob (fraction)', () => {
    const m = matchWith(undefined)
    m.btts_over25_prob = 0.53
    const r = computeRawLines(m)
    expect(r[21]).toBe('GG+O2.5 53%')
  })

  it('marketBannerFromLines("combo") renvoie label + pct', () => {
    const r = computeRawLines(matchWith(48))
    const banner = marketBannerFromLines(r, 'combo')
    expect(banner).toMatchObject({ label: 'GG+O2.5 48%', pct: 48, dominant: false })
  })

  it('sans donnée combo → cellule "--" et pas de bannière', () => {
    const r = computeRawLines(matchWith(0))
    expect(r[21]).toBe('--')
    expect(marketBannerFromLines(r, 'combo')).toBeNull()
  })
})

describe('combo — tableColumns', () => {
  it('colonne COMBO présente après CORNERS (tier 860)', () => {
    const keys = (w) => columnsForWidth(w).map((c) => c.key)
    expect(keys(860)).toContain('combo')
    const full = keys(1040)
    expect(full.indexOf('combo')).toBe(full.indexOf('corners') + 1)
    const col = TABLE_COLUMNS.find((c) => c.key === 'combo')
    expect(col).toMatchObject({ label: 'COMBO', sortKey: 'combo' })
  })
})

describe('combo — dashboardFilters', () => {
  it('MARKET_TABS / VALID_MARKETS / seuil', () => {
    expect(MARKET_TABS).toContain('combo')
    expect(VALID_MARKETS).toContain('combo')
    expect(MARKET_MIN_PCT.combo).toBe(40)
  })

  it('hasMarketPrediction("combo") filtre au seuil 40%', () => {
    const strong = toRawLines(matchWith(48))
    const weak = toRawLines(matchWith(30))
    expect(hasMarketPrediction(strong, 'combo')).toBe(true)
    expect(hasMarketPrediction(weak, 'combo')).toBe(false)
    expect(marketPct(strong, 'combo')).toBe(48)
  })

  it('computeChipCounts compte l onglet combo et applyMarketFilter le respecte', () => {
    const list = [matchWith(48), matchWith(30)]
    const counts = computeChipCounts(list)
    expect(counts.combo).toBe(1)
    expect(applyMarketFilter(list, 'combo')).toHaveLength(1)
  })
})
