const database = require('../core/database')
const logger = require('../core/logger')
const scraperProxy = require('../services/scraperProxy')

const SOFASCORE_API = 'https://www.sofascore.com/api/v1'
const scheduleCache = new Map()

function extractNumericId(rawId) {
  const m = String(rawId).match(/(\d+)/)
  return m ? m[1] : null
}

function normalizeTeam(name) {
  return name
    .toLowerCase()
    .replace(/[fc|sc|fk|if|bk|dfs|afc|utd|united]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function teamsMatch(name1, name2) {
  return (
    normalizeTeam(name1).includes(normalizeTeam(name2)) ||
    normalizeTeam(name2).includes(normalizeTeam(name1))
  )
}

async function getEventById(matchId) {
  const numericId = extractNumericId(matchId)
  if (!numericId) return null
  const url = `${SOFASCORE_API}/event/${numericId}`
  try {
    return await scraperProxy.fetchJSON(url)
  } catch (e) {
    return null
  }
}

async function getEventsByDate(dateStr) {
  if (scheduleCache.has(dateStr)) return scheduleCache.get(dateStr)
  const url = `${SOFASCORE_API}/sport/football/scheduled-events/${dateStr}`
  try {
    const data = await scraperProxy.fetchJSON(url)
    const events = data?.events || []
    scheduleCache.set(dateStr, events)
    return events
  } catch (e) {
    return []
  }
}

function matchFromEvents(events, homeTeam, awayTeam) {
  for (const ev of events) {
    const h = ev.homeTeam?.name || ev.homeTeam || ''
    const a = ev.awayTeam?.name || ev.awayTeam || ''
    if (teamsMatch(h, homeTeam) && teamsMatch(a, awayTeam)) return ev
    if (teamsMatch(h, awayTeam) && teamsMatch(a, homeTeam)) return ev
  }
  return null
}

async function getSofaScore(match) {
  const details = await getEventById(match.id)
  if (details?.event) {
    const ev = details.event
    const h = ev.homeTeam?.name || ''
    const a = ev.awayTeam?.name || ''
    if (teamsMatch(h, match.homeTeam) && teamsMatch(a, match.awayTeam)) return details
  }

  if (match.startTimestamp) {
    const dateStr = new Date(match.startTimestamp * 1000).toISOString().split('T')[0]
    const events = await getEventsByDate(dateStr)
    const ev = matchFromEvents(events, match.homeTeam, match.awayTeam)
    if (ev) {
      const statusType = ev.status?.type || 'scheduled'
      if (statusType === 'finished' || ev.status?.code === 100) {
        const homeScore = ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0
        const awayScore = ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0
        return { event: ev, _fromSchedule: true, homeScore, awayScore }
      }
    }
  }

  return null
}

async function backfillScores() {
  console.log('\n📋 [BACKFILL SCORES] Starting...')

  const threeHoursAgoSec = Math.floor(Date.now() / 1000) - 3 * 60 * 60

  const matches = await database
    .prepare(
      `
    SELECT id, "homeTeam", "awayTeam", "startTimestamp", "fullData", status
    FROM matches
    WHERE (status IS NULL OR status NOT IN ('FT', 'finished', 'Finished', 'Ended', 'AET', 'PEN'))
    AND "startTimestamp" < ?
    ORDER BY "startTimestamp" ASC
  `
    )
    .all(threeHoursAgoSec)

  if (matches.length === 0) {
    console.log('✅ [BACKFILL SCORES] No past pending matches found.')
    return { processed: 0 }
  }

  console.log(`📡 [BACKFILL SCORES] Found ${matches.length} past matches to backfill.`)

  let updated = 0
  let failed = 0
  let skipped = 0

  for (const m of matches) {
    try {
      logger.info(`🔍 [BACKFILL SCORES] Fetching: ${m.homeTeam} vs ${m.awayTeam} (${m.id})`)

      const resultData = await getSofaScore(m)

      if (!resultData || !resultData.event) {
        logger.warn(`⚠️ [BACKFILL SCORES] No details for ${m.id} (${m.homeTeam} vs ${m.awayTeam})`)
        failed++
        await new Promise((r) => setTimeout(r, 600))
        continue
      }

      const event = resultData.event
      const statusType = event.status?.type || 'scheduled'

      if (statusType !== 'finished' && event.status?.code !== 100) {
        logger.info(`⏳ [BACKFILL SCORES] ${m.id} not finished yet (${statusType})`)
        skipped++
        await new Promise((r) => setTimeout(r, 600))
        continue
      }

      const homeScore = resultData._fromSchedule
        ? resultData.homeScore
        : (event.homeScore?.current ?? event.homeScore?.normaltime ?? 0)
      const awayScore = resultData._fromSchedule
        ? resultData.awayScore
        : (event.awayScore?.current ?? event.awayScore?.normaltime ?? 0)

      const currentFullData = m.fullData ? JSON.parse(m.fullData) : {}
      const updatedFullData = JSON.stringify({
        ...currentFullData,
        status: 'finished',
        score: { home: homeScore, away: awayScore },
        incidents: event.incidents || [],
      })

      const updateResult = await database
        .prepare(
          `
        UPDATE matches
        SET status = 'FT', "scoreHome" = ?, "scoreAway" = ?, "fullData" = ?
        WHERE id = ?
      `
        )
        .run(homeScore, awayScore, updatedFullData, m.id)

      if (updateResult && updateResult.changes > 0) {
        logger.info(`✅ [BACKFILL SCORES] ${m.homeTeam} ${homeScore}-${awayScore} ${m.awayTeam}`)
        updated++
      } else {
        logger.warn(`⚠️ [BACKFILL SCORES] Update returned 0 changes for ${m.id}`)
        failed++
      }
    } catch (e) {
      logger.error(`❌ [BACKFILL SCORES] ${m.id}: ${e.message}`)
      failed++
    }

    await new Promise((r) => setTimeout(r, 1200))
  }

  console.log(
    `\n✅ [BACKFILL SCORES] Done. Updated: ${updated}, Failed: ${failed}, Skipped: ${skipped}, Total: ${matches.length}`
  )

  // ⚡ Trigger settlement so freshly backfilled scores feed accuracyStore,
  // the bets tracker, prediction_history and the adaptive-learning loop.
  if (updated > 0) {
    try {
      const settlement = require('../services/settlementService')
      if (typeof settlement.settleFinishedMatches === 'function') {
        const settled = await settlement.settleFinishedMatches(true)
        console.log(`✅ [BACKFILL SCORES] Settlement done: ${JSON.stringify(settled)}`)
      }
    } catch (e) {
      logger.warn(`[BACKFILL SCORES] Settlement skipped: ${e.message}`)
    }
    try {
      const { runAutoBacktest } = require('../services/autoBacktestService')
      await runAutoBacktest()
    } catch (e) {
      logger.warn(`[BACKFILL SCORES] Auto-backtest skipped: ${e.message}`)
    }
  }

  return { processed: updated, failed, skipped, total: matches.length }
}

if (require.main === module) {
  backfillScores()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[BACKFILL SCORES] Fatal:', e)
      process.exit(1)
    })
}

module.exports = { backfillScores }
