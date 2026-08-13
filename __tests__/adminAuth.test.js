/**
 * Unit tests for src/utils/adminAuth.js — in-memory admin token helper.
 * The token must be kept in memory only and never persisted to storage.
 */

const adminAuth = require('../src/utils/adminAuth')

describe('adminAuth (in-memory token)', () => {
  afterEach(() => {
    adminAuth.clearAdminToken()
  })

  it('starts with no token', () => {
    expect(adminAuth.hasAdminToken()).toBe(false)
    expect(adminAuth.getAdminToken()).toBe('')
  })

  it('stores and returns a token in memory', () => {
    adminAuth.setAdminToken('secret-123')
    expect(adminAuth.hasAdminToken()).toBe(true)
    expect(adminAuth.getAdminToken()).toBe('secret-123')
  })

  it('trims whitespace on set', () => {
    adminAuth.setAdminToken('  spaced-token  ')
    expect(adminAuth.getAdminToken()).toBe('spaced-token')
  })

  it('ignores empty input on set', () => {
    adminAuth.setAdminToken('   ')
    expect(adminAuth.hasAdminToken()).toBe(false)
    expect(adminAuth.getAdminToken()).toBe('')
  })

  it('clears the token', () => {
    adminAuth.setAdminToken('secret-123')
    adminAuth.clearAdminToken()
    expect(adminAuth.hasAdminToken()).toBe(false)
    expect(adminAuth.getAdminToken()).toBe('')
  })

  it('overwrites the previous token', () => {
    adminAuth.setAdminToken('first')
    adminAuth.setAdminToken('second')
    expect(adminAuth.getAdminToken()).toBe('second')
  })
})
