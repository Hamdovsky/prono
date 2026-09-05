const os = require('os')
const path = require('path')
const fs = require('fs')

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return { ...actual }
})

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}))

const { createQuotaManager } = require('../services/sourceQuotaManager')

describe('SourceQuotaManager apifootball', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'))

  let originalCwd
  beforeAll(() => {
    originalCwd = process.cwd()
    process.chdir(tmpDir)
    process.env.API_FOOTBALL_ENABLED = 'true'
  })
  afterAll(() => {
    delete process.env.API_FOOTBALL_ENABLED
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers apifootball with default limit of 100', () => {
    const m = createQuotaManager('apifootball')
    expect(m.getQuotaStatus().limit).toBe(100)
  })

  it('allows a match within quota and registers it', () => {
    const m = createQuotaManager('apifootball')
    expect(m.canProcessMatch('match-1')).toBe(true)
    m.registerMatch('match-1')
    expect(m.getQuotaStatus().remaining).toBe(m.getQuotaStatus().limit - 1)
  })
})
