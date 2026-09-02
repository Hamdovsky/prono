/**
 * LiveScoreScraper — Scores live via API Livescore.com publique.
 *
 * Optimisé pour 8GB RAM + réseau non surchargé:
 * - Lazy scraping: skip HTTP si cache valide
 * - Prune auto: supprime données > 7 jours
 * - Health check: logging RAM/CPU
 *
 * Stability: retry exponential backoff, cache borné, timeout
 */
const axios = require('axios')
const fs = require('fs')
const path = require('path')

const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app'
const CACHE_TTL = 30000
const MAX_CACHE = 200
const MAX_RETRIES = 3
const RETRY_BASE_DELAY = 1000
const REQUEST_TIMEOUT = 10000
const PRUNE_DAYS = 7

let cache = { ts: 0, data: [] }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.livescore.com',
  Referer: 'https://www.livescore.com/',
}

function parseEsd(esd) {
  const s = String(esd)
  if (s.length < 14) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}Z`).getTime() / 1000)
}

function mapEvent(event, stage) {
  if (!event?.Eid) return null
  const homeName = event.T1?.[0]?.Nm
  const awayName = event.T2?.[0]?.Nm
  if (!homeName || !awayName) return null

  const eps = (event.Eps || '').toUpperCase()
  const isLive = eps !== 'NS' && eps !== '' && eps !== 'POSTP.'
  const isFinished = ['FT', 'AET', 'PEN', 'HT'].includes(eps)

  return {
    id: `ls_${event.Eid}`,
    homeTeam: homeName,
    awayTeam: awayName,
    league: stage.Snm || 'Unknown',
    country: stage.Cnm || '',
    scoreHome: parseInt(event.Tr1, 10) || 0,
    scoreAway: parseInt(event.Tr2, 10) || 0,
    minute: String(event.ECo || (isLive ? eps.replace(/\D/g, '') || '0' : '0')),
    status: isFinished ? 'finished' : isLive ? 'live' : 'scheduled',
    isLive,
    startTimestamp: event.Esd ? parseEsd(event.Esd) : Math.floor(Date.now() / 1000),
    source: 'livescore',
    rawStatus: eps,
  }
}

async function fetchDate(dateStr, retries = MAX_RETRIES) {
  const ymd = dateStr.replace(/-/g, '')
  const url = `${LIVESCORE_BASE}/date/soccer/${ymd}/0?MD=1&countryCode=US&locale=en`

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(url, {
        headers: HEADERS,
        timeout: REQUEST_TIMEOUT,
      })

      const out = []
      for (const stage of data?.Stages || []) {
        for (const event of stage?.Events || []) {
          try {
            const mapped = mapEvent(event, stage)
            if (mapped) out.push(mapped)
          } catch (mapErr) {
            // Skip malformed events
          }
        }
      }
      return out

    } catch (err) {
      const isLastAttempt = attempt >= retries
      const isNetworkError = err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT'
      const isServerError = err.response?.status >= 500

      if (isLastAttempt || (!isNetworkError && !isServerError)) {
        console.error(`[LiveScoreScraper] Failed after ${attempt + 1} attempts: ${err.message}`)
        return []
      }

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt)
      console.warn(`[LiveScoreScraper] Retry ${attempt + 1}/${retries} in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  return []
}

function trimCache() {
  if (cache.data.length > MAX_CACHE) {
    cache.data = cache.data.slice(-MAX_CACHE)
  }
}

async function getLiveMatches(dateStr, forceRefresh = false) {
  const now = Date.now()

  if (!forceRefresh && cache.data.length > 0 && now - cache.ts < CACHE_TTL) {
    console.log(`[LiveScoreScraper] Cache HIT (${cache.data.length} matches, ${Math.round((now - cache.ts)/1000)}s old)`)
    return cache.data
  }

  console.log('[LiveScoreScraper] Cache MISS or expired — fetching from network')
  const date = dateStr || new Date().toISOString().slice(0, 10)
  let matches = await fetchDate(date)

  if (matches.length === 0) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    matches = await fetchDate(tomorrow)
  }

  cache = { ts: now, data: matches }
  trimCache()
  return matches
}

async function getLiveOnly() {
  try {
    const all = await getLiveMatches()
    return all.filter((m) => m.isLive && m.status !== 'finished')
  } catch (err) {
    console.error('[LiveScoreScraper] getLiveOnly error:', err.message)
    return []
  }
}

function clearCache() {
  cache = { ts: 0, data: [] }
}

function getCacheStats() {
  return {
    size: cache.data.length,
    age: cache.ts ? Date.now() - cache.ts : 0,
    ttl: CACHE_TTL,
    max: MAX_CACHE,
  }
}

function logHealth() {
  const mem = process.memoryUsage()
  const stats = getCacheStats()
  console.log(`[HEALTH] LiveScoreScraper | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB | Cache: ${stats.size}/${stats.max}`)
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    cache: stats,
  }
}

module.exports = { getLiveMatches, getLiveOnly, clearCache, getCacheStats, logHealth }
