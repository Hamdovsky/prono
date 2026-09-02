/**
 * scrape_prematch.js — Scraping des matchs pre-match + cotes BetExplorer.
 *
 * Stability:
 * - Delay 2s entre lots (évite rate limit)
 * - Retry 2x par match
 * - Partial save (sauvegarde après chaque lot)
 * - Graceful error handling
 *
 * Usage:
 *   node scripts/scrape_prematch.js --days 3 --limit 30
 *   node scripts/scrape_prematch.js --resume  (reprend où ça s'est arrêté)
 */

const fs = require('fs')
const path = require('path')

const LiveScoreScraper = require('../services/scrapers/LiveScoreScraper')
const BetExplorerScraper = require('../services/scrapers/ScrapingBypassScraper')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const OUTPUT_FILE = path.join(BASE_DIR, 'data', 'today_matches.json')
const HISTORY_FILE = path.join(BASE_DIR, 'data', 'odds_history.jsonl')

const MAX_BATCH_SIZE = 5
const BATCH_DELAY = 2000
const MAX_RETRIES = 2
const RETRY_DELAY = 1500

async function fetchOddsWithRetry(homeTeam, awayTeam, league, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const odds = await BetExplorerScraper.getOdds(homeTeam, awayTeam, league, '', '', null)
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
      if (attempt >= retries) return null
    } catch (err) {
      if (attempt >= retries) {
        console.warn(`[scrape] ${homeTeam} vs ${awayTeam}: failed after ${retries + 1} attempts`)
        return null
      }
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY))
    }
  }
  return null
}

async function processBatch(matches, startIdx) {
  const batch = matches.slice(startIdx, startIdx + MAX_BATCH_SIZE)
  const results = []

  for (const m of batch) {
    const odds = await fetchOddsWithRetry(m.homeTeam, m.awayTeam, m.league)
    if (odds) {
      m.odds = odds
      const ou = odds.over25 ? `O/U: ${odds.over25}/${odds.under25}` : ''
      console.log(`  + ${m.homeTeam} vs ${m.awayTeam} [${m.league}]`)
      console.log(`    1=${odds.home} X=${odds.draw || '--'} 2=${odds.away} ${ou}`)
    } else {
      console.log(`  - ${m.homeTeam} vs ${m.awayTeam}: no odds`)
    }
    results.push(m)
    await new Promise((r) => setTimeout(r, BATCH_DELAY))
  }

  return results
}

function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
      if (Array.isArray(data)) return data
    }
  } catch (err) {
    console.warn(`[scrape] Could not load existing file: ${err.message}`)
  }
  return []
}

function saveMatches(matches) {
  try {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(matches, null, 2), 'utf8')
  } catch (err) {
    console.error(`[scrape] Save failed: ${err.message}`)
  }
}

function appendHistory(matches) {
  if (!matches || matches.length === 0) return
  const withOdds = matches.filter((m) => m.odds)
  if (withOdds.length === 0) return

  const lines = withOdds.map((m) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      match_id: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league,
      date: m.scrapeDate || m.date,
      odds: m.odds,
    })
  ).join('\n') + '\n'

  try {
    fs.appendFileSync(HISTORY_FILE, lines, 'utf8')
    console.log(`[scrape] Appended ${withOdds.length} records to history`)
  } catch (err) {
    console.error(`[scrape] History append failed: ${err.message}`)
  }
}

async function scrapePreMatch({ numDays = 1, limit = 30, resume = false } = {}) {
  console.log(`[scrape_prematch] J+${numDays}, limit=${limit}, resume=${resume}`)

  const existing = resume ? loadExisting() : []
  const existingIds = new Set(existing.map((m) => m.id))

  const today = new Date()
  const allMatches = []

  for (let d = 0; d < numDays; d++) {
    const date = new Date(today)
    date.setDate(date.getDate() + d)
    const dateStr = date.toISOString().slice(0, 10)

    try {
      const matches = await LiveScoreScraper.getLiveMatches(dateStr)
      const upcoming = matches.filter((m) => !m.isLive && m.status !== 'finished')
      console.log(`  ${dateStr}: ${upcoming.length} upcoming`)
      allMatches.push(...upcoming.map((m) => ({ ...m, scrapeDate: dateStr })))
    } catch (err) {
      console.error(`[scrape] Livescore error for ${dateStr}: ${err.message}`)
    }
  }

  const newMatches = allMatches.filter((m) => !existingIds.has(m.id))
  const toProcess = [...existing, ...newMatches].slice(0, limit)

  console.log(`[scrape] Processing ${toProcess.length} matches (${newMatches.length} new)...\n`)

  const totalBatches = Math.ceil(toProcess.length / MAX_BATCH_SIZE)
  let processed = 0

  for (let b = 0; b < totalBatches; b++) {
    const start = b * MAX_BATCH_SIZE
    console.log(`\n[scrape] Batch ${b + 1}/${totalBatches}`)

    try {
      const batchResults = await processBatch(toProcess, start)

      // Partial save after each batch
      saveMatches(toProcess.slice(0, start + batchResults.length))

      const withOdds = batchResults.filter((m) => m.odds).length
      console.log(`  Progress: ${start + batchResults.length}/${toProcess.length} | with odds: ${withOdds}`)

    } catch (err) {
      console.error(`[scrape] Batch ${b + 1} failed: ${err.message}`)
    }
  }

  const withOdds = toProcess.filter((m) => m.odds).length
  console.log(`\n[scrape] Done: ${toProcess.length} matches, ${withOdds} with odds`)

  appendHistory(toProcess)

  return toProcess
}

const args = process.argv.slice(2)
let numDays = 1
let limit = 30
let resume = false

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) numDays = parseInt(args[i + 1])
  if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1])
  if (args[i] === '--resume') resume = true
}

scrapePreMatch({ numDays, limit, resume })
  .then((matches) => {
    const withOdds = matches.filter((m) => m.odds && m.odds.home >= 1.3)
    console.log(`\n=== PRONOSTICS (cote >= 1.3): ${withOdds.length} ===`)
    withOdds.slice(0, 10).forEach((m) => {
      const o = m.odds
      const probHome = o.home ? Math.round((1 / o.home) * 100) : 0
      console.log(`${m.homeTeam} vs ${m.awayTeam} [${m.league}]`)
      console.log(`  1=${o.home} (${probHome}%) | X=${o.draw || '--'} | 2=${o.away || '--'}`)
    })
    process.exit(0)
  })
  .catch((err) => {
    console.error('[scrape_prematch] Fatal error:', err.message)
    process.exit(1)
  })
