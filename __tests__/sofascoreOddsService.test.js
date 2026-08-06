const { parseOverUnder25, parseBtts } = require('../services/sofascoreOddsService')

describe('sofascoreOddsService market parsers', () => {
  describe('parseOverUnder25', () => {
    it('parses Over/Under 2.5 from featured.default choices', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: 'Over 2.5', decimalValue: 1.85 },
              { name: 'Under 2.5', decimalValue: 1.95 },
            ],
          },
        },
      }
      expect(parseOverUnder25(data)).toEqual({ over25: 1.85, under25: 1.95 })
    })

    it('handles fractionalValue', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: 'Over 2.5', fractionalValue: '5/6' },
              { name: 'Under 2.5', fractionalValue: '10/11' },
            ],
          },
        },
      }
      const res = parseOverUnder25(data)
      expect(res.over25).toBeCloseTo(1.833, 2)
      expect(res.under25).toBeCloseTo(1.909, 2)
    })

    it('handles 2.5+ / 2.5- naming', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: '2.5+', decimalValue: 1.8 },
              { name: '2.5-', decimalValue: 2.0 },
            ],
          },
        },
      }
      expect(parseOverUnder25(data)).toEqual({ over25: 1.8, under25: 2.0 })
    })

    it('returns null when 2.5 line is missing', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: 'Over 3.5', decimalValue: 1.7 },
              { name: 'Under 3.5', decimalValue: 2.1 },
            ],
          },
        },
      }
      expect(parseOverUnder25(data)).toBeNull()
    })

    it('returns null when no featured market', () => {
      expect(parseOverUnder25({ featured: { default: { choices: [] } } })).toBeNull()
      expect(parseOverUnder25(null)).toBeNull()
    })
  })

  describe('parseBtts', () => {
    it('parses BTTS Yes/No', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: 'Both teams to score - Yes', decimalValue: 1.8 },
              { name: 'Both teams to score - No', decimalValue: 2.05 },
            ],
          },
        },
      }
      expect(parseBtts(data)).toEqual({ btts_yes: 1.8, btts_no: 2.05 })
    })

    it('parses plain Yes/No choices', () => {
      const data = {
        featured: {
          default: {
            choices: [
              { name: 'Yes', decimalValue: 1.9 },
              { name: 'No', decimalValue: 1.9 },
            ],
          },
        },
      }
      expect(parseBtts(data)).toEqual({ btts_yes: 1.9, btts_no: 1.9 })
    })

    it('handles nested featured.markets', () => {
      const data = {
        featured: {
          markets: [
            { id: 'btts', choices: [{ name: 'Yes', decimalValue: 1.75 }] },
            { id: 'unrelated', choices: [{ name: '1', decimalValue: 2.0 }] },
          ],
        },
      }
      expect(parseBtts(data)).toBeNull()
    })

    it('returns null when incomplete', () => {
      expect(parseBtts(null)).toBeNull()
      expect(parseBtts({ featured: { default: { choices: [] } } })).toBeNull()
    })
  })
})
