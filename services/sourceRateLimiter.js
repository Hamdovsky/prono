// sourceRateLimiter.js — per-source request throttling for the resilient
// multi-source fixture orchestrator.
//
// Unlike the legacy global RateLimiter (hardcoded for Flashscore), this keeps
// one independent Bottleneck limiter per source name so each provider can
// declare its own rate (config/sources/*.js: rate = { max, perMs, minTime, maxConcurrent }).
//
// If a provider declares no `rate`, calls pass through unthrottled.

const Bottleneck = require('bottleneck')

class SourceRateLimiter {
  constructor() {
    this.limiters = new Map() // name -> Bottleneck
  }

  _get(name, rate) {
    if (!rate) return null
    let lim = this.limiters.get(name)
    if (!lim) {
      lim = new Bottleneck({
        maxConcurrent: rate.maxConcurrent || 1,
        minTime: rate.minTime || 0,
        reservoir: rate.max || 10,
        reservoirRefreshAmount: rate.max || 10,
        reservoirRefreshInterval: rate.perMs || 60000,
      })
      this.limiters.set(name, lim)
    }
    return lim
  }

  // Runs fn through the source's limiter (or directly if no rate configured).
  async schedule(name, rate, fn) {
    const lim = this._get(name, rate)
    if (!lim) return fn()
    return lim.schedule(fn)
  }

  status(name) {
    const lim = this.limiters.get(name)
    if (!lim) return null
    return { running: lim.counts().RUNNING, queued: lim.counts().QUEUED }
  }
}

module.exports = { SourceRateLimiter }
