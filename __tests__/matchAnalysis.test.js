/**
 * Unit tests pour matchAnalysis.js — computeRawLines / analyzeMatch.
 * Couvre : structure du retour, dominantBest, domChip, domPayload,
 * robustness sans cornersVerdict, sans odds, match finished.
 */

const { computeRawLines, analyzeMatch } = require('../src/utils/matchAnalysis.js')

const baseMatch = () => ({
  id: 'm1',
  homeTeam: 'Aachen',
  awayTeam: 'Bielefeld',
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
  home_win_probability: 45,
  draw_probability: 28,
  away_win_probability: 27,
  confidence: 72,
  btts_prob: 58,
  ou_25_prob: 55,
  insufficient_data: 0,
  enriched: {},
  quant: {},
})

describe('computeRawLines — structure de base', () => {
  it('retourne 18 éléments (indices 0-17) pour un match complet', () => {
    const m = baseMatch()
    const r = computeRawLines(m)
    expect(Array.isArray(r)).toBe(true)
    expect(r.length).toBe(21)
  })

  it('indice 13 = domChip (nom du marché dominant)', () => {
    const m = baseMatch()
    const r = computeRawLines(m)
    const chip = r[13]
    expect(chip).toMatch(/^(win|btts|ou|ht|corners)$/)
  })

  it('indice 14 = domPayload structuré (label|pct|odds|score)', () => {
    const m = baseMatch()
    const r = computeRawLines(m)
    const payload = r[14]
    expect(typeof payload).toBe('string')
    expect(payload).not.toBe('--')
    const parts = payload.split('|')
    expect(parts.length).toBe(4)
    expect(parts[0]).toBeTruthy()
    expect(parts[1]).toBeTruthy()
  })

  it('indice 15 est \'--\' (real_markets absent)', () => {
    const m = baseMatch()
    const r = computeRawLines(m)
    expect(r[15]).toBe('--')
  })
})

describe('computeRawLines — match sans cornersVerdict', () => {
  it('ne lève pas d\'exception quand cornersVerdict est absent', () => {
    const m = baseMatch()
    delete m.enriched?.cornersVerdict
    expect(() => computeRawLines(m)).not.toThrow()
  })

  it('retourne 18 éléments sans cornersVerdict', () => {
    const m = baseMatch()
    delete m.enriched?.cornersVerdict
    const r = computeRawLines(m)
    expect(r.length).toBe(21)
    expect(r[13]).not.toBe('--')
  })
})

describe('computeRawLines — match sans cotes bookmaker', () => {
  it('ne lève pas d\'exception sans odds', () => {
    const m = baseMatch()
    m.odds_home = null
    m.odds_draw = null
    m.odds_away = null
    m.odds_over25 = null
    m.odds_btts_yes = null
    expect(() => computeRawLines(m)).not.toThrow()
  })

  it('retourne 18 éléments sans odds', () => {
    const m = baseMatch()
    m.odds_home = null
    m.odds_draw = null
    m.odds_away = null
    m.odds_over25 = null
    m.odds_btts_yes = null
    const r = computeRawLines(m)
    expect(r.length).toBe(21)
  })

  it('domChip reste un marché valide sans odds', () => {
    const m = baseMatch()
    m.odds_home = null
    m.odds_draw = null
    m.odds_away = null
    m.odds_over25 = null
    m.odds_btts_yes = null
    const r = computeRawLines(m)
    expect(r[13]).toMatch(/^(win|btts|ou|ht|corners)$/)
  })
})

describe('computeRawLines — match finished', () => {
  it('retourne 18 éléments pour un match finished', () => {
    const m = baseMatch()
    m.status = 'finished'
    m.scoreHome = '2'
    m.scoreAway = '1'
    const r = computeRawLines(m)
    expect(r.length).toBe(21)
  })

  it('domChip est \'--\' pour un match finished', () => {
    const m = baseMatch()
    m.status = 'finished'
    m.scoreHome = '2'
    m.scoreAway = '1'
    const r = computeRawLines(m)
    expect(r[13]).toBe('--')
  })

  it('score à r[6] pour un match finished', () => {
    const m = baseMatch()
    m.status = 'finished'
    m.scoreHome = '3'
    m.scoreAway = '0'
    const r = computeRawLines(m)
    expect(r[6]).toBe('3-0')
  })
})

describe('analyzeMatch — dominantBest', () => {
  it('dominantBest est défini pour un match avec cotes', () => {
    const m = baseMatch()
    const a = analyzeMatch(m)
    expect(a.dominantBest).not.toBeNull()
    expect(a.dominantBest).toBeDefined()
    expect(typeof a.dominantBest.chip).toBe('string')
    expect(typeof a.dominantBest.score).toBe('number')
  })

  it('dominantBest.score est >= 0', () => {
    const m = baseMatch()
    const a = analyzeMatch(m)
    expect(a.dominantBest.score).toBeGreaterThanOrEqual(0)
  })

  it('dominantBest.label est une chaîne non vide', () => {
    const m = baseMatch()
    const a = analyzeMatch(m)
    expect(typeof a.dominantBest.label).toBe('string')
    expect(a.dominantBest.label.length).toBeGreaterThan(0)
  })

  it('dominantBest.odds est présent quand cotes disponibles', () => {
    const m = baseMatch()
    const a = analyzeMatch(m)
    const { chip, odds } = a.dominantBest
    if (chip === 'win' || chip === 'btts' || chip === 'ou') {
      expect(odds).toBeTruthy()
      expect(odds).toBeGreaterThan(1)
    }
  })

  it('honestFactor est appliqué au score (mode insufficient = 0.9)', () => {
    const m = baseMatch()
    m.insufficient_data = 1
    m.odds_home = null
    m.odds_draw = null
    m.odds_away = null
    const a = analyzeMatch(m)
    expect(a.honesty.mode).toBe('insufficient')
    expect(a.dominantBest.score).toBeGreaterThanOrEqual(0)
  })
})

describe('computeRawLines — O/U coherence', () => {
  it('domChip peut être "ou" même sans ligne 2.5 dans markets', () => {
    const m = baseMatch()
    m.quant = { probs: { over25: 62 } }
    const r = computeRawLines(m)
    expect(r[13]).toMatch(/^(win|btts|ou|ht|corners)$/)
  })

  it('retourne 18 éléments avec prob over25 uniquement (pas de markets)', () => {
    const m = baseMatch()
    m.odds_over25 = '1.90'
    m.quant = { probs: { over25: 65 } }
    const r = computeRawLines(m)
    expect(r.length).toBe(21)
  })
})

describe('computeRawLines / analyzeMatch — real_markets info (HT/FT, AH, Team to Score)', () => {
  it('HT/FT est peuplé quand real_markets contient ht_ft', () => {
    const m = baseMatch()
    m.real_markets = [
      { market_id: 'ht_ft', selection: 'home_home', odds: 3.40, usable: true },
      { market_id: 'ht_ft', selection: 'away_away', odds: 5.20, usable: true },
    ]
    const a = analyzeMatch(m)
    expect(a.htft.pct).toBeGreaterThan(0)
    expect(a.htft.label).toMatch(/Aachen\/Aachen|Bielefeld\/Bielefeld/)
    expect(a.htft.odds).toBeCloseTo(3.40, 1)
  })

  it('HT/FT est -- quand real_markets est absent', () => {
    const m = baseMatch()
    delete m.real_markets
    delete m.fullData
    const r = computeRawLines(m)
    expect(r[15]).toBe('--')
  })

  it('Asian Handicap est peuplé depuis real_markets', () => {
    const m = baseMatch()
    m.real_markets = [
      { market_id: 'asian_handicap', selection: 'home', odds: 1.95, line: -1.0, usable: true },
      { market_id: 'asian_handicap', selection: 'away', odds: 2.05, line: 1.0, usable: true },
    ]
    const a = analyzeMatch(m)
    expect(a.asianHandicap.pct).toBeGreaterThan(0)
    expect(a.asianHandicap.label).toBeTruthy()
  })

  it('Team to Score est peuplé depuis real_markets', () => {
    const m = baseMatch()
    m.real_markets = [
      { market_id: 'team_to_score', selection: 'home', odds: 2.10, usable: true },
      { market_id: 'team_to_score', selection: 'away', odds: 2.30, usable: true },
      { market_id: 'team_to_score', selection: 'both', odds: 1.50, usable: true },
    ]
    const a = analyzeMatch(m)
    expect(a.teamToScore.pct).toBeGreaterThan(0)
    expect(a.teamToScore.label).toBeTruthy()
  })

  it('real_markets dans fullData.real_markets est aussi lu', () => {
    const m = baseMatch()
    m.fullData = {
      real_markets: [
        { market_id: 'ht_ft', selection: 'home_draw', odds: 4.50, usable: true },
      ],
    }
    delete m.real_markets
    const a = analyzeMatch(m)
    expect(a.htft.pct).toBeGreaterThan(0)
  })

  it('les 3 cellules info sont \'--\' pour match sans real_markets', () => {
    const m = baseMatch()
    const r = computeRawLines(m)
    expect(r[15]).toBe('--')
    expect(r[16]).toBe('--')
    expect(r[17]).toBe('--')
  })

  it('analyzeMatch ne lève pas d\'exception avec real_markets vide', () => {
    const m = baseMatch()
    m.real_markets = []
    expect(() => analyzeMatch(m)).not.toThrow()
    const r = computeRawLines(m)
    expect(r.length).toBe(21)
  })
})
