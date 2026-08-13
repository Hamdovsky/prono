const {
  normalizeTeamName,
  formatDateUTC,
  buildMatchKey,
  getOrComputeMatchKey,
} = require('../services/matchKey')

describe('normalizeTeamName()', () => {
  it('lowercases and trims', () => {
    expect(normalizeTeamName('  Real Madrid  ')).toBe('real madrid')
  })
  it('strips accents', () => {
    expect(normalizeTeamName('Côte d’Ivoire')).toContain('cote d ivoire')
    expect(normalizeTeamName('São Paulo')).toBe('sao paulo')
    expect(normalizeTeamName('Barcelonà')).toBe('barcelona')
  })
  it('collapses punctuation and whitespace', () => {
    expect(normalizeTeamName('Man City   - Utd')).toBe('man city utd')
    expect(normalizeTeamName('A.S. Roma')).toBe('a s roma')
  })
  it('returns empty for falsy', () => {
    expect(normalizeTeamName(null)).toBe('')
    expect(normalizeTeamName(undefined)).toBe('')
    expect(normalizeTeamName('')).toBe('')
  })
})

describe('buildMatchKey()', () => {
  const ts = Date.UTC(2026, 7, 13, 18, 0, 0) // 2026-08-13 18:00 UTC
  it('same teams + same date => same key', () => {
    const a = buildMatchKey({ homeTeam: 'Real Madrid', awayTeam: 'Barcelonà', startTimestamp: ts })
    const b = buildMatchKey({ homeTeam: 'real   madrid', awayTeam: 'barcelona', startTimestamp: ts })
    expect(a).toBe(b)
  })
  it('same teams + different date => different key', () => {
    const a = buildMatchKey({ homeTeam: 'RM', awayTeam: 'BAR', startTimestamp: Date.UTC(2026, 7, 13) })
    const b = buildMatchKey({ homeTeam: 'RM', awayTeam: 'BAR', startTimestamp: Date.UTC(2026, 7, 14) })
    expect(a).not.toBe(b)
  })
  it('home/away swap => different key', () => {
    const a = buildMatchKey({ homeTeam: 'A', awayTeam: 'B', startTimestamp: ts })
    const b = buildMatchKey({ homeTeam: 'B', awayTeam: 'A', startTimestamp: ts })
    expect(a).not.toBe(b)
  })
  it('returns null when a team name is missing', () => {
    expect(buildMatchKey({ homeTeam: '', awayTeam: 'B', startTimestamp: ts })).toBeNull()
  })
  it('appends disambiguator when provided', () => {
    const a = buildMatchKey({ homeTeam: 'A', awayTeam: 'B', startTimestamp: ts })
    const b = buildMatchKey({ homeTeam: 'A', awayTeam: 'B', startTimestamp: ts, disambiguator: '1800' })
    expect(b).toBe(`${a}|1800`)
  })
})

describe('formatDateUTC()', () => {
  it('formats YYYYMMDD', () => {
    expect(formatDateUTC(Date.UTC(2026, 7, 13))).toBe('20260813')
    expect(formatDateUTC(Date.UTC(2026, 0, 5))).toBe('20260105')
  })
})

describe('getOrComputeMatchKey()', () => {
  const ts = Date.UTC(2026, 7, 13, 12, 0, 0)
  it('returns stored match_key when present', () => {
    const row = { homeTeam: 'A', awayTeam: 'B', startTimestamp: ts, match_key: 'already-set' }
    expect(getOrComputeMatchKey(row)).toBe('already-set')
  })
  it('computes lazily when match_key is null (retro-compat)', () => {
    const row = { homeTeam: 'Real Madrid', awayTeam: 'FC Barcelona', startTimestamp: ts, match_key: null }
    const key = getOrComputeMatchKey(row)
    expect(key).toBeTruthy()
    expect(key).toContain('|20260813')
  })
  it('computes lazily when match_key key is absent', () => {
    const row = { homeTeam: 'A', awayTeam: 'B', startTimestamp: ts }
    expect(getOrComputeMatchKey(row)).toBe(buildMatchKey(row))
  })
  it('returns null for empty row', () => {
    expect(getOrComputeMatchKey(null)).toBeNull()
    expect(getOrComputeMatchKey(undefined)).toBeNull()
  })
})
