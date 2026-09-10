const actualFs = jest.requireActual('fs')
const path = require('path')

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  })),
}))

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

describe('cronSchedules — plus jamais execSync dans le process serveur', () => {
  it('le source ne contient aucun appel execSync', () => {
    const src = actualFs
      .readFileSync(path.join(__dirname, '../services/cronSchedules.js'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(src).not.toMatch(/execSync\s*\(/)
  })

  it('init() déclenche les jobs via spawn uniquement', () => {
    jest.useFakeTimers()
    const cp = require('child_process')
    const cronSchedules = require('../services/cronSchedules')
    cronSchedules.init()
    // horizon > 24 h : report 07:00 UTC + backup 03:00 UTC au moins une fois
    jest.advanceTimersByTime(25 * 3600 * 1000)
    expect(cp.execSync).not.toHaveBeenCalled()
    expect(cp.spawn).toHaveBeenCalled()
    jest.useRealTimers()
  })
})
