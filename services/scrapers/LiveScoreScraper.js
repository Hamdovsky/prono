/**
 * LiveScoreScraper — Scores live via API Livescore.com publique.
 * 100% gratuit, sans API key, couvre ~62 ligues mondiales.
 *
 * Role: Scores live + minute + équipes
 * Ne fournit PAS de cotes (utiliser BetExplorer/Flashscore pour ça)
 *
 * Usage:
 *   const ls = require('./LiveScoreScraper')
 *   const matches = await ls.getLiveMatches()
 */
const axios = require('axios')

const LIVESCORE_BASE = 'https://prod-public-api.livescore.com/v1/api/app'
const CACHE_TTL = 30000
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

async function fetchDate(dateStr) {
  const ymd = dateStr.replace(/-/g, '')
  const url = `${LIVESCORE_BASE}/date/soccer/${ymd}/0?MD=1&countryCode=US&locale=en`
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 })
  const out = []
  for (const stage of data?.Stages || []) {
    for (const event of stage?.Events || []) {
      const mapped = mapEvent(event, stage)
      if (mapped) out.push(mapped)
    }
  }
  return out
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
  return matches
}

async function getLiveOnly() {
  const all = await getLiveMatches()
  return all.filter((m) => m.isLive && m.status !== 'finished')
}

module.exports = { getLiveMatches, getLiveOnly, fetchDate }
