/**
 * LiveScoreScraper — Scores live via API Livescore.com publique.
 * 100% gratuit, sans API key, couvre ~62 ligues mondiales.
 *
 * Role: Scores live + minute + équipes
 * Ne fournit PAS de cotes (utiliser BetExplorer/Flashscore pour ça)
 *
 * Stability: retry exponential backoff, cache borné, timeout, error handling complet
 *
 * Usage:
 *   const ls = require('./LiveScoreScraper')
 *   const matches = await ls.getLiveMatches()
 */
const axios = require('axios')

const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app'
const CACHE_TTL = 30000
const MAX_CACHE = 500
const MAX_RETRIES = 3
const RETRY_BASE_DELAY = 1000
const REQUEST_TIMEOUT = 10000

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
  const year = s.slice(0, 4)
  const mon = s.slice(4, 6)
  const day = s.slice(6, 8)
  const hour = s.slice(8, 10)
  const min = s.slice(10, 12)
  const sec = s.slice(12, 14)
  return Math.floor(new Date(`${year}-${mon}-${day}T${hour}:${min}:${sec}Z`).getTime() / 1000)
}

function mapEvent(event, stage) {
  if (!event?.Eid) return null
  const homeName = event.T1?.[0]?.Nm
  const awayName = event.T2?.[0]?.Nm
  if (!homeName || !awayName) return null

  const eps = (event.Eps || '').toUpperCase()
  const isLive = eps !== 'NS' && eps !== '' && eps !== 'POSTP.'
  const isFinished = ['FT', 'AET', 'PEN', 'HT'].includes(eps)

  const minute = event.ECo || (isLive ? eps.replace(/\D/g, '') || '0' : '0')
  const scoreHome = parseInt(event.Tr1, 10) || 0
  const scoreAway = parseInt(event.Tr2, 10) || 0

  return {
    id: `ls_${event.Eid}`,
    homeTeam: homeName,
    awayTeam: awayName,
    league: stage.Snm || 'Unknown',
    country: stage.Cnm || '',
    scoreHome,
    scoreAway,
    minute: String(minute),
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
      console.warn(`[LiveScoreScraper] Retry ${attempt + 1}/${retries} in ${delay}ms: ${err.message}`)
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

async function getLiveMatches(dateStr) {
  const now = Date.now()

  if (cache.data.length > 0 && now - cache.ts < CACHE_TTL) {
    return cache.data
  }

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
    age: Date.now() - cache.ts,
    ttl: CACHE_TTL,
  }
}

module.exports = { getLiveMatches, getLiveOnly, clearCache, getCacheStats }
