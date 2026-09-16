/**
 * oddsportalClient.js — E48 cote PARENT du sous-process OddsPortal.
 *
 * Aucune dependance a Playwright ici : on spawn SofascoreScraping/oddsportalRunner.js
 * (qui, lui, trouve playwright dans son propre node_modules). Protocol NDJSON sur
 * pipes stdio, contrat identique au precedent ScrapingBypassScraper.js:112-149
 * mais en Node et PERSISTANT (1 seul spawn pour N ligues).
 *
 * Cycle de vie : 1 process enfant = 1 browser Chromium chaud + ODDSPORTAL_CONCURRENCY
 * contextes reutilises. `close()` est appele en fin de cycle de cron pour liberer
 * la memoire. Un responseTimeout evite qu'une ligue bloquee fige tout le cycle.
 */
const { spawn } = require('child_process')
const path = require('path')
const readline = require('readline')
const logger = require('../core/logger')

const RUNNER_DIR = path.join(__dirname, '..', 'SofascoreScraping')
const RUNNER = path.join(RUNNER_DIR, 'oddsportalRunner.js')
const RESPONSE_TIMEOUT_MS = Number(process.env.ODDSPORTAL_RESPONSE_TIMEOUT_MS || 180000)
const READY_TIMEOUT_MS = Number(process.env.ODDSPORTAL_READY_TIMEOUT_MS || 90000)

let _proc = null
let _rl = null
let _pending = null
let _startedAt = 0
let _lastError = null

function isRunning() {
  return !!_proc && _proc.exitCode === null && !_proc.killed
}

function _kill(reason) {
  _lastError = reason || _lastError
  if (_proc) {
    try { _proc.kill() } catch (_) {}
  }
  _proc = null
  _rl = null
}

function _resolvePending(msg) {
  if (!_pending) return
  const { resolve, timer, expectSlug } = _pending
  if (expectSlug && msg && msg.op === 'fetchLeague') {
    const got = msg.result && msg.result.slug
    if (got && got !== expectSlug) return
  }
  _pending = null
  clearTimeout(timer)
  resolve(msg)
}

function start() {
  if (isRunning()) return
  _startedAt = Date.now()
  _lastError = null
  try {
    _proc = spawn(process.execPath, [RUNNER], {
      cwd: RUNNER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    _lastError = e.message
    logger.warn(`[ODDSPORTAL-CLIENT] spawn failed: ${e.message}`)
    _proc = null
    return
  }

  _rl = readline.createInterface({ input: _proc.stdout })
  _rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try { msg = JSON.parse(s) } catch (_) { return }
    _resolvePending(msg)
  })

  _proc.stderr.on('data', (chunk) => {
    const txt = String(chunk).slice(0, 300).replace(/\s+/g, ' ').trim()
    if (txt) logger.debug(`[ODDSPORTAL-RUNNER] ${txt}`)
  })

  _proc.on('exit', (code) => {
    logger.warn(`[ODDSPORTAL-CLIENT] runner exited code=${code} after ${Date.now() - _startedAt}ms`)
    _resolvePending({ ok: false, error: `runner exited (code=${code})` })
    _proc = null
    _rl = null
  })
}

function send(msg, timeoutMs, expectSlug) {
  return new Promise((resolve) => {
    if (!isRunning()) { resolve({ ok: false, error: _lastError || 'runner not running' }); return }
    if (_pending) { resolve({ ok: false, error: 'runner busy (concurrent send)' }); return }
    const timer = setTimeout(() => {
      if (_pending) {
        const wasResolve = _pending.resolve
        _pending = null
        // Kill imperatif : sans ca, la reponse en vol du runner serait livree a
        // la PROCHAINE requete (race condition observee E48 : nm-cup timeout ->
        // regionalliga-nordost recevait les matchs NM Cup). _kill() force un
        // respawn propre a la requete suivante.
        _kill(`timeout after ${timeoutMs || RESPONSE_TIMEOUT_MS}ms (op=${msg && msg.op})`)
        wasResolve({ ok: false, error: `response timeout (${timeoutMs || RESPONSE_TIMEOUT_MS}ms)` })
      }
    }, timeoutMs || RESPONSE_TIMEOUT_MS)
    _pending = { resolve, timer, expectSlug: expectSlug || null }
    try {
      _proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (e) {
      clearTimeout(timer)
      _pending = null
      resolve({ ok: false, error: e.message })
    }
  })
}

async function waitReady() {
  start()
  if (!isRunning()) return false
  const r = await send({ op: 'ping' }, READY_TIMEOUT_MS)
  return !!(r && r.ok)
}

async function fetchLeagueOdds(slug) {
  const clean = String(slug || '').replace(/^\/+|\/+$/g, '')
  if (!isRunning()) {
    const ready = await waitReady()
    if (!ready) return { slug: clean, matches: [], noOddsPublished: 0, errors: 1, ms: 0, error: _lastError || 'runner not ready' }
  }
  const r = await send({ op: 'fetchLeague', slug: clean }, undefined, clean)
  if (!r || !r.ok || !r.result) {
    return { slug: clean, matches: [], noOddsPublished: 0, errors: 1, ms: 0, error: (r && r.error) || 'unknown' }
  }
  return r.result
}

async function close() {
  if (!isRunning()) { _proc = null; _rl = null; _pending = null; return }
  try {
    await send({ op: 'close' }, 15000)
  } catch (_) {}
  try { _proc.stdin.end() } catch (_) {}
  await new Promise((r) => setTimeout(r, 300))
  if (isRunning()) { try { _proc.kill() } catch (_) {} }
  _proc = null
  _rl = null
  _pending = null
}

function status() {
  return {
    running: isRunning(),
    startedAt: _startedAt,
    uptimeMs: _startedAt ? Date.now() - _startedAt : 0,
    lastError: _lastError,
  }
}

module.exports = { fetchLeagueOdds, close, start, waitReady, status, RUNNER, RUNNER_DIR }
