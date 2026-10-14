const db = require('../core/database')
const sofa = require('./scrapers/SofascoreBypass')
const logger = require('../core/logger')

/**
 * Convertit les stats SofaScore (objet plat curl_cffi) en items exploitables par
 * autopsyService._normalizeStats (Case 2 : [{ name, home, away }]).
 */
function statsToItems(s) {
  if (!s || !s.found) return null
  const num = (v) => (v == null || isNaN(parseFloat(v)) ? 0 : parseFloat(v))
  const items = []
  const push = (name, hk, ak) => {
    if (s[hk] == null && s[ak] == null) return
    items.push({ name, home: num(s[hk]), away: num(s[ak]) })
  }
  push('Expected goals', 'expectedGoalsHome', 'expectedGoalsAway')
  push('Ball possession', 'possessionHome', 'possessionAway')
  push('Total shots', 'shotsHome', 'shotsAway')
  push('Shots on target', 'shotsOnTargetHome', 'shotsOnTargetAway')
  push('Corner kicks', 'cornersHome', 'cornersAway')
  return items.length ? items : null
}

class RetroSyncService {
  /**
   * Finds and synchronizes matches that started in the past but remain in 'scheduled' status.
   * This ensures the Autopsy Engine has data to analyze even after server downtime.
   */
  async syncPastMatches() {
    logger.info('🔄 [RETRO-SYNC] Starting sync for past pending matches...')

    try {
      const now = Date.now()
      const twoHoursAgo = now - 2.5 * 60 * 60 * 1000 // 2.5 hours threshold

      let pendingMatches

      // Force PG-compatible query if using Postgres
      const usingPG = process.env.DATABASE_URL && db.query && !db.db
      if (usingPG) {
        const result = await db.query(
          `
                    SELECT id, "homeTeam", "awayTeam", timestamp, "fullData"
                    FROM matches
                    WHERE (status IN ('scheduled', 'NOT_STARTED') OR status IS NULL)
                    AND CAST("startTimestamp" AS bigint) < $1
                    ORDER BY "startTimestamp" ASC
                    LIMIT 50
                `,
          [Math.floor(twoHoursAgo / 1000)]
        )
        pendingMatches = result.rows || []
      } else {
        // SQLite: use `startTimestamp` field (epoch seconds), same as PG branch
        pendingMatches = await db
          .prepare(
            `
                    SELECT id, "homeTeam", "awayTeam", timestamp, "fullData"
                    FROM matches
                    WHERE (status IN ('scheduled', 'NOT_STARTED') OR status IS NULL)
                    AND "startTimestamp" IS NOT NULL
                    AND "startTimestamp" < ?
                    ORDER BY "startTimestamp" ASC
                    LIMIT 50
                `
          )
          .all(Math.floor(twoHoursAgo / 1000))
      }

      if (pendingMatches.length === 0) {
        logger.info('✅ [RETRO-SYNC] No past pending matches found.')
        return { processed: 0 }
      }

      logger.info(`📡 [RETRO-SYNC] Found ${pendingMatches.length} matches to synchronize.`)

      let syncCount = 0
      for (const match of pendingMatches) {
        try {
          const matchId = match.id
          logger.info(
            `🔍 [RETRO-SYNC] Fetching final data for: ${match.homeTeam} vs ${match.awayTeam} (${matchId})`
          )

          // E91 : SofaScore via le pont curl_cffi. L'ancien SofaAPI Node recevait
          // l'id interne "livescore_xxxx" -> GET /event/livescore_xxxx = 403, qui
          // déclenchait le cooldown global 480s et affamait TOUT SofaScore
          // (LEARN, live, enrichissement). On résout d'abord le vrai id numérique.
          let startTimestamp = null
          try {
            startTimestamp = JSON.parse(match.fullData || '{}').startTimestamp || null
          } catch {
            startTimestamp = null
          }
          const eventId = await sofa.resolveEvent(
            match.homeTeam,
            match.awayTeam,
            startTimestamp
          )
          if (!eventId) {
            logger.warn(`⚠️ [RETRO-SYNC] No SofaScore event resolved for ${matchId} — skipped`)
            await new Promise((r) => setTimeout(r, 1000))
            continue
          }

          const [status, stats] = await Promise.all([
            sofa.getEventStatus(eventId),
            sofa.getEventStats(eventId).catch(() => null),
          ])
          if (!status || !status.found) {
            logger.warn(`⚠️ [RETRO-SYNC] Match details not found for ${matchId} (event ${eventId})`)
            await new Promise((r) => setTimeout(r, 1000))
            continue
          }

          // Proceed only if match is truly finished
          if (!status.finished) {
            logger.info(`⏳ [RETRO-SYNC] Match ${matchId} still in progress (${status.status})`)
            await new Promise((r) => setTimeout(r, 1000))
            continue
          }

          const homeScore = status.home ?? 0
          const awayScore = status.away ?? 0

          // Update fullData with stats and final results
          const currentFullData = JSON.parse(match.fullData || '{}')

          const updatedFullData = {
            ...currentFullData,
            stats: statsToItems(stats) || currentFullData.stats || [],
            status: 'finished',
            score: { home: homeScore, away: awayScore },
            incidents: currentFullData.incidents || [],
            _sofaEventId: eventId,
          }

          // Update database
          db.prepare(
            `
                        UPDATE matches 
                        SET status = 'FT', 
                            "scoreHome" = ?, 
                            "scoreAway" = ?, 
                            "fullData" = ?
                        WHERE id = ?
                    `
          ).run(homeScore, awayScore, JSON.stringify(updatedFullData), matchId)

          logger.info(
            `✅ [RETRO-SYNC] Successfully synchronized: ${match.homeTeam} ${homeScore}-${awayScore} ${match.awayTeam}`
          )
          syncCount++
        } catch (err) {
          logger.error(`❌ [RETRO-SYNC] Failed to sync match ${match.id}: ${err.message}`)
        }

        // Small sleep to be nice to API
        await new Promise((r) => setTimeout(r, 1000))
      }

      logger.info(`🏁 [RETRO-SYNC] Sync complete. Processed ${syncCount} matches.`)
      return { processed: syncCount }
    } catch (error) {
      logger.error(`❌ [RETRO-SYNC] Global error: ${error.message}`)
      return { error: error.message }
    }
  }
}

module.exports = new RetroSyncService()
