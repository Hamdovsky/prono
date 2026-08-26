/**
 * Structured News Extractor Tests
 * Extraction structurée absences/retours/compositions depuis headlines RSS
 * Format de sortie conforme au "moteur d'extraction" (voir CHANGELOG_AUDIT.md)
 */

const extractor = require('../services/structuredNewsExtractor')
const { _internals } = extractor

describe('StructuredNewsExtractor', () => {
  describe('isEnabled (opt-in)', () => {
    it('should be disabled by default', () => {
      delete process.env.STRUCTURED_NEWS_ENABLED
      expect(extractor.isEnabled()).toBe(false)
    })

    it('should be enabled with STRUCTURED_NEWS_ENABLED=true', () => {
      process.env.STRUCTURED_NEWS_ENABLED = 'true'
      expect(extractor.isEnabled()).toBe(true)
      delete process.env.STRUCTURED_NEWS_ENABLED
    })
  })

  describe('extractPlayerCandidates', () => {
    it('should extract capitalized player names', () => {
      const names = _internals.extractPlayerCandidates(
        'Thibaut Courtois injured before El Clasico against Barcelona'
      )
      expect(names).toContain('Thibaut Courtois')
    })

    it('should reject generic words as player names', () => {
      const names = _internals.extractPlayerCandidates('Match Report: League Cup Update')
      expect(names).toHaveLength(0)
    })
  })

  describe('extractAbsencesFromHeadlines', () => {
    it('should extract an injured player with position and Crucial level (GK)', () => {
      const items = [
        {
          title:
            'Real Madrid dealt huge blow as goalkeeper Thibaut Courtois ruled out of El Clasico with muscle injury',
          source: 'google_news_en',
        },
      ]
      const absences = _internals.extractAbsencesFromHeadlines('Real Madrid', items)
      expect(absences.length).toBeGreaterThanOrEqual(1)
      const courtois = absences.find((a) => /courtois/i.test(a.player_name))
      expect(courtois).toBeTruthy()
      expect(courtois.position).toBe('GK')
      expect(courtois.reason).toBe('Injury')
      expect(['Crucial', 'Important']).toContain(courtois.importance_level)
    })

    it('should detect suspension reason', () => {
      const items = [
        {
          title: 'Midfielder Sergio Busquets suspended for the derby after red card',
          source: 'test',
        },
      ]
      const absences = _internals.extractAbsencesFromHeadlines('Sevilla', items)
      const busquets = absences.find((a) => /busquets/i.test(a.player_name))
      expect(busquets).toBeTruthy()
      expect(busquets.reason).toBe('Suspension')
      expect(busquets.position).toBe('MID')
    })

    it('should deduplicate players mentioned in multiple headlines', () => {
      const items = [
        { title: 'Kylian Mbappe doubtful for Ligue 1 clash', source: 'a' },
        { title: 'Mbappe hamstring injury confirmed by club doctor', source: 'b' },
      ]
      const absences = _internals.extractAbsencesFromHeadlines('Real Madrid', items)
      const mbappes = absences.filter((a) => /mbappe/i.test(a.player_name))
      expect(mbappes).toHaveLength(1)
      // 2 mentions -> au moins Important
      expect(mbappes[0].importance_level).toBe('Important')
    })
  })

  describe('mapOfficialInjuries', () => {
    it('should map official injuries with high confidence', () => {
      const mapped = _internals.mapOfficialInjuries([
        { name: 'Marco Verratti', reason: 'thigh injury', position: 'MID', source: 'sofascore_official' },
      ])
      expect(mapped).toHaveLength(1)
      expect(mapped[0].player_name).toBe('Marco Verratti')
      expect(mapped[0].position).toBe('MID')
      expect(mapped[0].reason).toBe('Injury')
    })

    it('should return empty array for missing input', () => {
      expect(_internals.mapOfficialInjuries(null)).toEqual([])
      expect(_internals.mapOfficialInjuries(undefined)).toEqual([])
    })
  })

  describe('extractReturns', () => {
    it('should extract returning players', () => {
      const items = [
        { title: 'Neymar returns to full training ahead of weekend clash', source: 'test' },
      ]
      const returns = _internals.extractReturns('Al Hilal', items)
      expect(returns.length).toBeGreaterThanOrEqual(1)
      expect(returns.some((r) => /neymar/i.test(r.player_name))).toBe(true)
      expect(['Fit', 'Starting']).toContain(returns[0].status)
    })
  })

  describe('extractLineup', () => {
    it('should detect official lineup and formation when mentioned', () => {
      const items = [
        { title: 'Confirmed lineup: Real Madrid will line up in a 4-3-3 formation tonight', source: 'x' },
      ]
      const lineup = _internals.extractLineup(items)
      expect(lineup.status).toBe('Official')
      expect(lineup.formation).toBe('4-3-3')
    })

    it('should stay Unknown for regular match previews', () => {
      const items = [{ title: 'Preview: big game this weekend at the stadium', source: 'x' }]
      const lineup = _internals.extractLineup(items)
      expect(lineup.status).toBe('Unknown')
      expect(lineup.formation).toBeNull()
    })
  })

  describe('computeImpactScore', () => {
    it('should be strongly negative for crucial absences', () => {
      const score = _internals.computeImpactScore(
        [
          { importance_level: 'Crucial' },
          { importance_level: 'Crucial' },
          { importance_level: 'Important' },
        ],
        []
      )
      expect(score).toBeLessThanOrEqual(-3)
      expect(score).toBeGreaterThanOrEqual(-5)
    })

    it('should be positive when key players return', () => {
      const score = _internals.computeImpactScore([], [
        { status: 'Starting' },
        { status: 'Fit' },
      ])
      expect(score).toBeGreaterThan(0)
    })

    it('should be 0 for empty news', () => {
      expect(_internals.computeImpactScore([], [])).toBe(0)
    })
  })

  describe('extract (integration)', () => {
    it('should produce the full structured JSON contract', () => {
      const result = extractor.extract({
        teamName: 'Real Madrid',
        opponent: 'Barcelona',
        items: [
          {
            title:
              'Real Madrid goalkeeper Thibaut Courtois ruled out of Clasico vs Barcelona with muscle injury',
            source: 'google_news_en',
          },
          { title: 'Kylian Mbappe returns to full training, set to face Barcelona', source: 'x' },
        ],
        injuries: [],
      })

      expect(result.team_name).toBe('Real Madrid')
      expect(result.opponent).toBe('Barcelona')
      expect(Array.isArray(result.absences)).toBe(true)
      expect(result.absences.some((a) => /courtois/i.test(a.player_name))).toBe(true)
      expect(result.returns.some((r) => /mbappe/i.test(r.player_name))).toBe(true)
      expect(typeof result.impact_score).toBe('number')
      expect(result.impact_score).toBeGreaterThanOrEqual(-5)
      expect(result.impact_score).toBeLessThanOrEqual(5)
      expect(result.lineup).toHaveProperty('status')
      expect(result.lineup).toHaveProperty('formation')
      expect(result.lineup).toHaveProperty('confirmed_players')
    })

    it('should merge official injuries and avoid duplicates', () => {
      const result = extractor.extract({
        teamName: 'PSG',
        items: [{ title: 'Presnel Kimpembe injured, defender sidelined for weeks', source: 'x' }],
        injuries: [
          { name: 'Presnel Kimpembe', reason: 'hamstring', position: 'DEF', source: 'sofascore_official' },
        ],
      })
      const kimpembes = result.absences.filter((a) => /kimpembe/i.test(a.player_name))
      expect(kimpembes).toHaveLength(1)
      expect(kimpembes[0].detail).toContain('sofascore_official')
    })

    it('should return neutral empty structure for no news', () => {
      const result = extractor.extract({ teamName: 'Some Team', items: [], injuries: [] })
      expect(result.absences).toEqual([])
      expect(result.returns).toEqual([])
      expect(result.news_sentiment).toBe('Neutral')
      expect(result.impact_score).toBe(0)
    })

    it('should never throw on malformed input', () => {
      expect(() => extractor.extract({})).not.toThrow()
      expect(() => extractor.extract({ teamName: null })).not.toThrow()
      expect(extractor.extract({ teamName: null }).team_name).toBeNull()
    })
  })

  describe('sentiment classification', () => {
    it('should classify Critical when crucial absences dominate', () => {
      const sentiment = _internals.buildSentiment(
        [
          { importance_level: 'Crucial' },
          { importance_level: 'Crucial' },
          { importance_level: 'Important' },
        ],
        []
      )
      expect(sentiment).toBe('Critical')
    })

    it('should classify Positive when returns dominate', () => {
      const sentiment = _internals.buildSentiment(
        [{ importance_level: 'Minor' }],
        [{ status: 'Starting' }, { status: 'Fit' }]
      )
      expect(sentiment).toBe('Positive')
    })
  })
})
