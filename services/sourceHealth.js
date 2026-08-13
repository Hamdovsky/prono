// sourceHealth.js — per-source failure tracking + cooldown for the resilient
// multi-source fixture orchestrator.
//
// A source that fails N consecutive times (403/404/500, timeout, network,
// or returns 0 results) is put into cooldown for a period, then re-enabled.
// Pattern mirrors services/scrapers/index.js health checks but is source-generic.

const DEFAULT_FAIL_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 300000 // 5 min (fixed cooldown, when explicitly configured)
const DEFAULT_BACKOFF_BASE_MS = 60000 // 1 min
const DEFAULT_BACKOFF_MAX_MS = 480000 // 8 min cap

// Exponential backoff for cooldown durations: base * 2^(failures - threshold),
// capped at backoffMaxMs. If a fixed cooldownMs is provided it overrides backoff.
class SourceHealthTracker {
  constructor(opts = {}) {
    this.failThreshold = opts.failThreshold ?? parseInt(process.env.SOURCE_FAIL_THRESHOLD || DEFAULT_FAIL_THRESHOLD, 10)
    this.cooldownMs = opts.cooldownMs ?? (process.env.SOURCE_COOLDOWN_MS ? parseInt(process.env.SOURCE_COOLDOWN_MS, 10) : null)
    this.backoffBaseMs = opts.backoffBaseMs ?? parseInt(process.env.SOURCE_BACKOFF_BASE_MS || DEFAULT_BACKOFF_BASE_MS, 10)
    this.backoffMaxMs = opts.backoffMaxMs ?? parseInt(process.env.SOURCE_BACKOFF_MAX_MS || DEFAULT_BACKOFF_MAX_MS, 10)
    this.sources = {} // name -> { failures, cooldownUntil, lastErrorType }
  }

  // Cooldown delay for the given failure count. Uses fixed cooldownMs if set,
  // otherwise exponential backoff growing past the failure threshold.
  _delayMs(failures) {
    if (this.cooldownMs != null) return this.cooldownMs
    const exp = Math.max(0, failures - this.failThreshold)
    return Math.min(this.backoffBaseMs * Math.pow(2, exp), this.backoffMaxMs)
  }

  recordSuccess(name) {
    if (!name) return
    this.sources[name] = { failures: 0, cooldownUntil: 0, lastErrorType: null }
  }

  recordFailure(name, type = 'unknown') {
    if (!name) return
    const s = this.sources[name] || { failures: 0, cooldownUntil: 0, lastErrorType: null }
    s.failures += 1
    s.lastErrorType = type
    if (s.failures >= this.failThreshold) {
      s.cooldownUntil = Date.now() + this._delayMs(s.failures)
    }
    this.sources[name] = s
  }

  // true if the source is usable right now (not in an active cooldown).
  isUsable(name) {
    if (!name) return false
    const s = this.sources[name]
    if (!s || !s.cooldownUntil) return true
    if (Date.now() >= s.cooldownUntil) {
      // cooldown elapsed -> auto re-enable
      this.recordSuccess(name)
      return true
    }
    return false
  }

  cooldownRemainingMs(name) {
    const s = this.sources[name]
    if (!s || !s.cooldownUntil) return 0
    const remaining = s.cooldownUntil - Date.now()
    return remaining > 0 ? remaining : 0
  }

  getStatus() {
    const out = {}
    for (const [name, s] of Object.entries(this.sources)) {
      out[name] = {
        failures: s.failures,
        disabled: s.cooldownUntil ? Date.now() < s.cooldownUntil : false,
        cooldownRemainingMs: this.cooldownRemainingMs(name),
        lastErrorType: s.lastErrorType,
      }
    }
    return out
  }

  reset() {
    this.sources = {}
  }
}

module.exports = { SourceHealthTracker }
