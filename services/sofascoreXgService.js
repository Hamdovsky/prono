const { getRandomUserAgent } = require('../SofascoreScraping/src/apiClient')
const logger = require('../core/logger')

const SOFA_API = 'https://www.sofascore.com/api/v1'
const SOFA_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
}

const cache = new Map()
const CACHE_TTL = 15 * 60 * 1000

class SofascoreXgService {
  constructor() {
    this.enabled = true
  }

  isAvailable() {
    return this.enabled
  }

  async fetchMatchXg(sofascoreId) {
    if (!sofascoreId) return null

    const cached = cache.get(String(sofascoreId))
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

    try {
      const url = `${SOFA_API}/event/${sofascoreId}/statistics`
      const res = await fetch(url, {
        headers: {
          ...SOFA_HEADERS,
          'User-Agent': getRandomUserAgent()
        },
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      })

      if (!res.ok) {
        logger.warn(`[SOFASCORE] xG fetch failed for ${sofascoreId}: HTTP ${res.status}`)
        return null
      }

      const body = await res.json()
      if (!body || !body.statistics) return null

      // Find "Expected goals" in the ALL period statistics items
      let xgH = null, xgA = null

      if (Array.isArray(body.statistics)) {
        for (const period of body.statistics) {
          if (!period.groups) continue
          for (const group of period.groups) {
            if (!group.statisticsItems) continue
            for (const item of group.statisticsItems) {
              if (!item || !item.name) continue
              const name = item.name.toLowerCase()
              if (name.includes('expected goals') || name.includes('xg') || name.includes('xG')) {
                const h = parseFloat(item.home)
                const a = parseFloat(item.away)
                if (!isNaN(h)) xgH = h
                if (!isNaN(a)) xgA = a
                break
              }
            }
            if (xgH !== null || xgA !== null) break
          }
          if (xgH !== null || xgA !== null) break
        }
      }

      if (xgH === null && xgA === null) {
        logger.warn(`[SOFASCORE] No xG found in statistics for ${sofascoreId}`)
        return null
      }

      const result = { home_xg: xgH, away_xg: xgA, source: 'SOFASCORE' }
      cache.set(String(sofascoreId), { data: result, ts: Date.now() })
      return result

    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        logger.warn(`[SOFASCORE] xG timeout for ${sofascoreId}`)
      } else {
        logger.warn(`[SOFASCORE] xG error for ${sofascoreId}: ${err.message}`)
      }
      return null
    }
  }
}

module.exports = new SofascoreXgService()
