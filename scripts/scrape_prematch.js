/**
 * scrape_prematch.js — Scraping des matchs pre-match + cotes.
 *
 * Usage: node scripts/scrape_prematch.js --days 1 --limit 30
 */

const fs = require('fs')
const path = require('path')

const LiveScoreScraper = require('../services/scrapers/LiveScoreScraper')
const BetExplorerScraper = require('../services/scrapers/ScrapingBypassScraper')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const OUTPUT_FILE = path.join(BASE_DIR, 'data', 'today_matches.json')

const CONCURRENCY = 5
const DELAY = 150

async function fetchOddsWithRetry(match, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const odds = await BetExplorerScraper.getOdds(match.homeTeam, match.awayTeam, match.league, '', '', null)
      if (odds && (odds.home_win || odds.over_25)) {
        return {
          home: odds.home_win,
          draw: odds.draw,
          away: odds.away_win,
          over25: odds.over_25,
          under25: odds.under_25,
          btts_yes: odds.btts_yes,
          btts_no: odds.btts_no,
        }
      }
      return null
    } catch (e) {
      if (i === retries) return null
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

async function processBatch(matches, startIdx) {
  const batch = matches.slice(startIdx, startIdx + CONCURRENCY)
  const results = await Promise.all(
    batch.map(async (m) => {
      const odds = await fetchOddsWithRetry(m)
      if (odds) {
        console.log(`  + ${m.homeTeam} vs ${m.awayTeam}: 1=${odds.home} X=${odds.draw} 2=${odds.away}`)
      } else {
        console.log(`  - ${m.homeTeam} vs ${m.awayTeam}`)
      }
      return { ...m, odds: odds || null }
    })
  )
  return results
}

async function scrapePreMatch({ numDays = 1, limit = 30 } = {}) {
  console.log(`[scrape_prematch] J+${numDays}, limit=${limit}...`)

  const today = new Date()
  const allMatches = []

  for (let d = 0; d < numDays; d++) {
    const date = new Date(today)
    date.setDate(date.getDate() + d)
    const dateStr = date.toISOString().slice(0, 10)
    const matches = await LiveScoreScraper.getLiveMatches(dateStr)
    const upcoming = matches.filter((m) => !m.isLive && m.status !== 'finished')
    console.log(`  ${dateStr}: ${upcoming.length} upcoming`)
    allMatches.push(...upcoming.map((m) => ({ ...m, scrapeDate: dateStr })))
  }

  const limited = allMatches.slice(0, limit)
  console.log(`[scrape_prematch] Processing ${limited.length} matches...\n`)

  const enriched = []
  const totalBatches = Math.ceil(limited.length / CONCURRENCY)

  for (let b = 0; b < totalBatches; b++) {
    const start = b * CONCURRENCY
    const batchResults = await processBatch(limited, start)
    enriched.push(...batchResults)

    const withOdds = enriched.filter((m) => m.odds).length
    console.log(`  Progress: ${enriched.length}/${limited.length} | with odds: ${withOdds}\n`)

    if (b < totalBatches - 1) {
      await new Promise((r) => setTimeout(r, DELAY))
    }
  }

  console.log(`\n[scrape_prematch] ${enriched.filter((m) => m.odds).length}/${enriched.length} with odds`)
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(enriched, null, 2), 'utf8')
  console.log(`[scrape_prematch] Saved to ${OUTPUT_FILE}`)

  return enriched
}

const args = process.argv.slice(2)
let numDays = 1
let limit = 30

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) numDays = parseInt(args[i + 1])
  if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1])
}

scrapePreMatch({ numDays, limit })
  .then((matches) => {
    const withOdds = matches.filter((m) => m.odds && m.odds.home >= 1.3)
    console.log(`\n=== PRONOSTICS (cote >= 1.3): ${withOdds.length} ===`)
    withOdds.slice(0, 10).forEach((m) => {
      const o = m.odds
      const probHome = o.home ? Math.round((1 / o.home) * 100) : 0
      const probDraw = o.draw ? Math.round((1 / o.draw) * 100) : 0
      const probAway = o.away ? Math.round((1 / o.away) * 100) : 0
      console.log(`${m.homeTeam} vs ${m.awayTeam} [${m.league}]`)
      console.log(`  1=${o.home} (${probHome}%) | X=${o.draw} (${probDraw}%) | 2=${o.away} (${probAway}%)`)
    })
    process.exit(0)
  })
  .catch((e) => {
    console.error('[scrape_prematch] Error:', e.message)
    process.exit(1)
  })
