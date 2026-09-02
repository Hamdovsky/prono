/**
 * scrape_prematch.js — Scraping des matchs pre-match + cotes.
 *
 * Optimisé pour 8GB RAM + réseau non surchargé:
 * - Batch restart: process.exit() entre ligues (cron relancera)
 * - Prune auto: supprime données > 7 jours
 * - Progress + ETA en minutes
 * - Delay 3s entre lots (économe CPU)
 * - Partial save après chaque lot
 *
 * Usage:
 *   node scripts/scrape_prematch.js --days 3 --limit 30
 */

const fs = require('fs')
const path = require('path')

const LiveScoreScraper = require('../services/scrapers/LiveScoreScraper')
const BetExplorerScraper = require('../services/scrapers/ScrapingBypassScraper')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const OUTPUT_FILE = path.join(BASE_DIR, 'data', 'today_matches.json')
const HISTORY_FILE = path.join(BASE_DIR, 'data', 'odds_history.jsonl')
const PRUNE_DAYS = 7

const MAX_BATCH_SIZE = 3
const BATCH_DELAY = 3000
const MAX_RETRIES = 2
const RETRY_DELAY = 1500
const MAX_DURATION = 30 * 60 * 1000

let startTime = Date.now()

// ─── Progress + ETA ─────────────────────────────────────────────────
function getProgress(current, total) {
  const elapsed = Date.now() - startTime
  const rate = current / elapsed
  const remaining = total - current
  const etaMs = remaining / rate
  const etaMin = Math.round(etaMs / 60000)
  const percent = Math.round((current / total) * 100)
  const barLen = 20
  const filled = Math.floor((percent / 100) * barLen)
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
  return { current, total, percent, etaMin, bar }
}

function logProgress(p, msg = '') {
  const etaStr = p.etaMin > 0 ? `ETA: ~${p.etaMin} min` : 'DONE'
  console.log(`[scrape] ${p.bar} ${p.current}/${p.total} (${p.percent}%) | ${etaStr} | ${msg}`)
}

function shouldContinue() {
  return Date.now() - startTime < MAX_DURATION
}

// ─── Odds Fetch with Retry ───────────────────────────────────────────
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

// ─── Process Batch ──────────────────────────────────────────────────
async function processBatch(matches, startIdx) {
  const batch = matches.slice(startIdx, startIdx + MAX_BATCH_SIZE)
  const results = []

  for (const m of batch) {
    if (!shouldContinue()) {
      console.log('[scrape] MAX_DURATION reached — stopping')
      return { results, timedOut: true }
    }

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

  return { results, timedOut: false }
}

// ─── Prune old data ────────────────────────────────────────────────
function pruneOldData() {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000
  let pruned = 0

  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
      const filtered = data.filter((m) => {
        const date = m.scrapeDate || m.date
        if (!date) return true
        return new Date(date).getTime() > cutoff
      })
      pruned = data.length - filtered.length
      if (pruned > 0) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(filtered, null, 2), 'utf8')
        console.log(`[scrape] Pruned ${pruned} old entries from today_matches.json`)
      }
    }
  } catch (err) {
    console.warn(`[scrape] Prune error: ${err.message}`)
  }

  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
      const filtered = []
      for (const line of lines) {
        try {
          const record = JSON.parse(line)
          const ts = new Date(record.timestamp).getTime()
          if (ts > cutoff) filtered.push(line)
        } catch (_) {}
      }
      pruned += lines.length - filtered.length
      if (lines.length - filtered.length > 0) {
        fs.writeFileSync(HISTORY_FILE, filtered.join('\n') + '\n', 'utf8')
        console.log(`[scrape] Pruned ${lines.length - filtered.length} old entries from odds_history.jsonl`)
      }
    }
  } catch (err) {
    console.warn(`[scrape] History prune error: ${err.message}`)
  }

  return pruned
}

// ─── Load / Save ─────────────────────────────────────────────────
function loadExisting() {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'))
      if (Array.isArray(data)) return data
    }
  } catch (err) {
    console.warn(`[scrape] Could not load existing: ${err.message}`)
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
  const withOdds = (matches || []).filter((m) => m.odds)
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
  } catch (err) {
    console.error(`[scrape] History append failed: ${err.message}`)
  }
}

// ─── Main ────────────────────────────────────────────────────────
async function scrapePreMatch({ numDays = 1, limit = 30, resume = false } = {}) {
  startTime = Date.now()
  console.log(`[scrape] Starting — J+${numDays}, limit=${limit}, resume=${resume}`)
  console.log(`[scrape] MAX_DURATION: ${MAX_DURATION / 60000} min`)

  // Prune old data first
  console.log('[scrape] Running prune...')
  pruneOldData()

  const existing = resume ? loadExisting() : []
  const existingIds = new Set(existing.map((m) => m.id))

  const today = new Date()
  const allMatches = []

  for (let d = 0; d < numDays; d++) {
    if (!shouldContinue()) break

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
    if (!shouldContinue()) {
      console.log('[scrape] MAX_DURATION reached — saving partial and exiting')
      saveMatches(toProcess.slice(0, processed))
      appendHistory(toProcess.slice(0, processed))
      process.exit(0)
    }

    console.log(`\n[scrape] Batch ${b + 1}/${totalBatches}`)

    const { results, timedOut } = await processBatch(toProcess, b * MAX_BATCH_SIZE)

    if (timedOut) {
      saveMatches(toProcess.slice(0, processed + results.length))
      appendHistory(toProcess.slice(0, processed + results.length))
      process.exit(0)
    }

    processed += results.length
    saveMatches(toProcess.slice(0, processed))

    const p = getProgress(processed, toProcess.length)
    logProgress(p, `Batch ${b + 1}/${totalBatches} done`)
  }

  console.log(`\n[scrape] Done: ${processed} matches processed`)
  appendHistory(toProcess)

  return toProcess
}

// ─── CLI ────────────────────────────────────────────────────────
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

    const elapsed = Math.round((Date.now() - startTime) / 60000)
    console.log(`\n[scrape] Total time: ${elapsed} min`)
    process.exit(0)
  })
  .catch((err) => {
    console.error('[scrape] Fatal error:', err.message)
    process.exit(1)
  })
