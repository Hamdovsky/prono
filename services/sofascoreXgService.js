/**
 * Sofascore xG — routé via SofascoreBypass (curl_cffi, fingerprint TLS navigateur).
 *
 * E88 : www.sofascore.com impose un fingerprint TLS navigateur ; un `fetch` Node
 * direct sur /event/{id}/statistics renvoie 403 {"reason":"Forbidden"} (vérifié).
 * Ce service délègue donc au pont Python SofascoreBypass → scripts/sofascore_bypass.py
 * (`stats --event`), qui expose expectedGoalsHome/Away en plus des corners/HT.
 *
 * Contrat de retour inchangé : { home_xg, away_xg, source:'SOFASCORE' } ou null.
 */
const logger = require('../core/logger')
const SofascoreBypass = require('./scrapers/SofascoreBypass')

const cache = new Map()
const CACHE_TTL = 15 * 60 * 1000
const SOFA_DISABLED =
  process.env.DISABLE_SOFASCORE !== undefined && process.env.DISABLE_SOFASCORE !== 'false'

function _num(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

class SofascoreXgService {
  constructor() {
    this.enabled = true
  }

  isAvailable() {
    return this.enabled && !SOFA_DISABLED
  }

  async fetchMatchXg(sofascoreId) {
    if (!sofascoreId || SOFA_DISABLED) return null

    const key = String(sofascoreId)
    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

    try {
      const stats = await SofascoreBypass.getEventStats(sofascoreId)
      if (!stats || !stats.found) return null

      const xgH = _num(stats.expectedGoalsHome)
      const xgA = _num(stats.expectedGoalsAway)
      if (xgH === null && xgA === null) {
        logger.warn(`[SOFASCORE] No xG found in statistics for ${sofascoreId}`)
        return null
      }

      const result = { home_xg: xgH, away_xg: xgA, source: 'SOFASCORE' }
      cache.set(key, { data: result, ts: Date.now() })
      return result
    } catch (err) {
      logger.warn(`[SOFASCORE] xG error for ${sofascoreId}: ${err.message}`)
      return null
    }
  }
}

module.exports = new SofascoreXgService()
