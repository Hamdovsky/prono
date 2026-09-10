/**
 * É13 — remedy python_service_down : plan Render gratuit = cold starts fréquents.
 * Le check doit tolérer le démarrage différé et le fix ne doit JAMAIS spawn
 * uvicorn local quand INFERENCE_URL pointe vers un service distant (OOM risk).
 */

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/utils/pythonResolver', () => ({ resolvePython: () => 'python' }))

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  exec: jest.fn(),
  spawn: jest.fn(),
}))
// après hoisting du mock, le require retourne L'instance de ces mocks
const cpMocks = require('child_process')

const remedies = require('../services/autoHealRemedies')
const pyRemedy = remedies.getRegistry().find((r) => r.id === 'python_service_down')

const saved = {}
beforeEach(() => {
  saved.INFERENCE_URL = process.env.INFERENCE_URL
  saved.RETRY = process.env.AUTOHEAL_PROBE_RETRY_MS
  process.env.AUTOHEAL_PROBE_RETRY_MS = '0'
  jest.clearAllMocks()
})
afterEach(() => {
  if (saved.INFERENCE_URL === undefined) delete process.env.INFERENCE_URL
  else process.env.INFERENCE_URL = saved.INFERENCE_URL
  if (saved.RETRY === undefined) delete process.env.AUTOHEAL_PROBE_RETRY_MS
  else process.env.AUTOHEAL_PROBE_RETRY_MS = saved.RETRY
  delete global.fetch
})

const okFetch = jest.fn(async () => ({ ok: true, status: 200 }))
const failFetch = jest.fn(async () => {
  throw new Error('timeout')
})
const failThenOk = jest
  .fn()
  .mockRejectedValueOnce(new Error('timeout'))
  .mockResolvedValueOnce({ ok: true, status: 200 })

it('check: cold start toléré — 1er probe échoue, retry ok => NOT detected', async () => {
  process.env.INFERENCE_URL = 'https://prono-fastapi-zfds.onrender.com'
  global.fetch = failThenOk
  const out = await pyRemedy.check()
  expect(out.detected).toBe(false)
  expect(global.fetch).toHaveBeenCalledTimes(2)
})

it('check: panne réelle (2 probes KO) => detected', async () => {
  process.env.INFERENCE_URL = 'https://prono-fastapi-zfds.onrender.com'
  global.fetch = failFetch
  const out = await pyRemedy.check()
  expect(out.detected).toBe(true)
})

it('fix distant: wake-up par /health, AUCUN spawn uvicorn local', async () => {
  process.env.INFERENCE_URL = 'https://prono-fastapi-zfds.onrender.com'
  global.fetch = okFetch
  const out = await pyRemedy.fix()
  expect(out.success).toBe(true)
  expect(out.detail).toMatch(/woken up/)
  expect(cpMocks.spawn).not.toHaveBeenCalled()
  expect(cpMocks.execSync).not.toHaveBeenCalled()
})

it('fix distant injoignable => success:false (pas de fallback spawn)', async () => {
  process.env.INFERENCE_URL = 'https://prono-fastapi-zfds.onrender.com'
  global.fetch = failFetch
  const out = await pyRemedy.fix()
  expect(out.success).toBe(false)
  expect(cpMocks.spawn).not.toHaveBeenCalled()
})

it('fix LOCAL (dev): INFERENCE_URL localhost => spawn conservé', async () => {
  process.env.INFERENCE_URL = 'http://127.0.0.1:8000'
  // setup.js mocke fs.existsSync false partout : autoriser fastapi_server.py
  require('fs').existsSync.mockReturnValue(true)
  global.fetch = okFetch
  cpMocks.spawn.mockReturnValue({ on: jest.fn(), unref: jest.fn() })
  cpMocks.execSync.mockReturnValue('Python 3.11')
  const out = await pyRemedy.fix()
  expect(cpMocks.spawn).toHaveBeenCalled()
  expect(typeof out.success).toBe('boolean')
}, 25000)
