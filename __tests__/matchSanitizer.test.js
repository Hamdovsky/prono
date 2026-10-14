/**
 * E91 — le sanitizer ne doit plus rejeter les clubs dont le nom officiel fait
 * 1-2 caractères (ex. « AB » = Akademisk Boldklub, Danemark).
 */
const sanitizer = require('../core/matchSanitizer')

describe('matchSanitizer — noms courts légitimes (E91)', () => {
  it('accepte AB / KB (clubs courts réels)', () => {
    expect(sanitizer.validateTeamNames({ homeTeam: 'HB Koege', awayTeam: 'AB' }).valid).toBe(
      true
    )
    expect(sanitizer.validateTeamNames({ homeTeam: 'AB', awayTeam: 'FC Copenhagen' }).valid).toBe(
      true
    )
    expect(sanitizer.validateTeamNames({ homeTeam: 'KB', awayTeam: 'Brondby' }).valid).toBe(true)
  })

  it('rejette toujours un nom de 1 caractère', () => {
    expect(sanitizer.validateTeamNames({ homeTeam: 'X', awayTeam: 'Team B' })).toEqual({
      valid: false,
      reason: 'TEAM_NAME_TOO_SHORT',
    })
  })

  it('rejette un nom de 2 caractères non listé', () => {
    expect(sanitizer.validateTeamNames({ homeTeam: 'Team B', awayTeam: 'zz' }).reason).toBe(
      'TEAM_NAME_TOO_SHORT'
    )
  })

  it('sanitizeMatches conserve HB Koege vs AB', () => {
    const { sanitized, rejected } = sanitizer.sanitizeMatches(
      [{ id: '1', homeTeam: 'HB Koege', awayTeam: 'AB', startTimestamp: Date.now() }],
      { logRejections: false }
    )
    expect(rejected).toHaveLength(0)
    expect(sanitized).toHaveLength(1)
  })

  it('sanitizeMatches rejette encore un nom court parasite', () => {
    const { rejected } = sanitizer.sanitizeMatches(
      [{ id: '2', homeTeam: '?', awayTeam: 'Team B', startTimestamp: Date.now() }],
      { logRejections: false }
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe('TEAM_NAME_TOO_SHORT')
  })
})
