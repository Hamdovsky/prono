// createMiscDao — extrait de core/database.js (split 2026-09-07, découpe scriptée, contenu verbatim).
const path = require('path')
const fs = require('fs')
const logger = require('../logger')
const {
  applyMarketPolicy,
  deriveBttsPick,
  deriveCornerPick,
  deriveHTPick,
} = require('../marketPolicy')
const { applyLeaguePolicy } = require('../leaguePolicy')

function createMiscDao(db) {
  return {
    getLeagueAverages: async () => {
      return { avgTotalGoals: 2.7, avgHomeGoals: 1.5, avgAwayGoals: 1.2, matchCount: 0 }
    },

    getAllLeaguesConfig: async () => {
      try {
        return db.prepare('SELECT * FROM leagues_config ORDER BY tier ASC, name ASC').all()
      } catch (e) {
        return []
      }
    },

    insertPlayerStat: async (stat) => {
      return true
    }, // Handled outside directly or ignored initially
    getPlayerStatsByTeam: async (teamName) => {
      return []
    },
    insertVisionLog: async (desc) => {
      return true
    },
    getHighImpactScheduledMatches: async () => {
      try {
        const rows = db
          .prepare(
            `
                  SELECT * FROM matches 
                  WHERE status = 'scheduled' 
                  AND (json_extract(fullData, '$.news_data') IS NOT NULL)
                  ORDER BY timestamp ASC LIMIT 20
              `
          )
          .all()
        return rows.map((r) => {
          const parsed = JSON.parse(r.fullData || '{}')
          return { ...r, ...parsed }
        })
      } catch (e) {
        return []
      }
    },
    getNewsPrecisionHistory: async () => {
      try {
        const rows = db
          .prepare(
            `
                  SELECT homeTeam, awayTeam, status, scoreHome, scoreAway, fullData
                  FROM matches 
                  WHERE status IN ('FT', 'finished', 'Finished')
                  ORDER BY timestamp DESC LIMIT 30
              `
          )
          .all()

        let total = 0
        let hits = 0
        const matches = []

        for (const r of rows) {
          const data = JSON.parse(r.fullData || '{}')
          const pronos =
            data.enriched && data.enriched.main_predictions
              ? data.enriched.main_predictions
              : data.predictions || []
          if (pronos.length === 0) continue

          total++
          const actual = r.scoreHome > r.scoreAway ? 'H' : r.scoreHome < r.scoreAway ? 'A' : 'D'

          // Simplified success check
          let success = false
          pronos.forEach((p) => {
            const val = (p.val || '').toLowerCase()
            if (val.includes('home') || val.includes('🏠') || val.includes('1')) {
              if (actual === 'H') success = true
            } else if (val.includes('away') || val.includes('✈️') || val.includes('2')) {
              if (actual === 'A') success = true
            } else if (val.includes('draw') || val.includes('x')) {
              if (actual === 'D') success = true
            }
          })

          if (success) hits++
          matches.push({
            id: r.id?.toString() || `${r.homeTeam}_${r.awayTeam}_${Date.now()}`,
            homeTeam: r.homeTeam,
            awayTeam: r.awayTeam,
            impact: 'High',
            success: success,
          })
        }

        return {
          total,
          accuracy: total > 0 ? Math.round((hits / total) * 100) : 0,
          matches: matches.slice(0, 10),
        }
      } catch (e) {
        return { total: 0, accuracy: 0, matches: [] }
      }
    },
    seedLeagues: async (leagues) => {
      return true
    },
    maintenance: async () => {
      try {
        logger.info('🧹 [DB] Running RAM & integrity optimization (VACUUM + ANALYZE)...')
        db.exec('ANALYZE')
        db.exec('VACUUM')
        logger.info('✅ [DB] Database maintenance complete.')
        return true
      } catch (e) {
        logger.error(`❌ [DB] Maintenance error: ${e.message}`)
        return false
      }
    },

    getGoalModelParameters: async (tournamentName) => {
      try {
        const rows = db
          .prepare('SELECT * FROM league_model_parameters WHERE tournament_name = ?')
          .all(tournamentName)
        return rows
      } catch (e) {
        logger.error(`[DB] getGoalModelParameters error: ${e.message}`)
        return []
      }
    },
    upsertGoalModelParameter: async (params) => {
      try {
        const ts = params.updated_at || new Date().toISOString()
        db.prepare(
          `
                  INSERT INTO league_model_parameters (tournament_name, team_name, attack_rating, defense_rating, hfa, rho, mu, distribution_type, num_matches, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(tournament_name, team_name) DO UPDATE SET
                      attack_rating = excluded.attack_rating,
                      defense_rating = excluded.defense_rating,
                      hfa = excluded.hfa,
                      rho = excluded.rho,
                      mu = excluded.mu,
                      distribution_type = excluded.distribution_type,
                      num_matches = excluded.num_matches,
                      updated_at = excluded.updated_at
              `
        ).run(
          params.tournament_name,
          params.team_name || null,
          params.attack_rating || 0,
          params.defense_rating || 0,
          params.hfa || 0.25,
          params.rho || -0.12,
          params.mu || 0.13,
          params.distribution_type || 'poisson',
          params.num_matches || 0,
          ts
        )
        return true
      } catch (e) {
        logger.error(`[DB] upsertGoalModelParameter error: ${e.message}`)
        return false
      }
    },
    getTeamPromosportStats: (teamName) => {
      try {
        const archivePath = path.resolve(__dirname, '../../data/historical_archive.sqlite')
        if (!fs.existsSync(archivePath)) {
          return null
        }
        const ArchiveDB = require('better-sqlite3')
        const adb = new ArchiveDB(archivePath)
        const key = teamName.toUpperCase().trim()

        const homeResults = adb
          .prepare(
            `
                  SELECT COUNT(*) as total,
                         SUM(CASE WHEN result = '1' THEN 1 ELSE 0 END) as wins,
                         SUM(CASE WHEN result = 'X' THEN 1 ELSE 0 END) as draws,
                         SUM(CASE WHEN result = '2' THEN 1 ELSE 0 END) as losses
                  FROM promosport_archive
                  WHERE UPPER(homeTeam) = ? AND is_finished = 1
              `
          )
          .get(key)

        const awayResults = adb
          .prepare(
            `
                  SELECT COUNT(*) as total,
                         SUM(CASE WHEN result = '2' THEN 1 ELSE 0 END) as wins,
                         SUM(CASE WHEN result = 'X' THEN 1 ELSE 0 END) as draws,
                         SUM(CASE WHEN result = '1' THEN 1 ELSE 0 END) as losses
                  FROM promosport_archive
                  WHERE UPPER(awayTeam) = ? AND is_finished = 1
              `
          )
          .get(key)

        adb.close()

        const homeTotal = homeResults?.total || 0
        const awayTotal = awayResults?.total || 0

        if (homeTotal + awayTotal < 3) return null

        const homeWinRate = homeTotal > 0 ? (homeResults.wins || 0) / homeTotal : null
        const homeDrawRate = homeTotal > 0 ? (homeResults.draws || 0) / homeTotal : null
        const awayWinRate = awayTotal > 0 ? (awayResults.wins || 0) / awayTotal : null
        const awayDrawRate = awayTotal > 0 ? (awayResults.draws || 0) / awayTotal : null

        return {
          homeGames: homeTotal,
          awayGames: awayTotal,
          homeWinRate,
          homeDrawRate,
          awayWinRate,
          awayDrawRate,
        }
      } catch (e) {
        logger.warn(`[DB] getTeamPromosportStats failed for ${teamName}: ${e.message}`)
        return null
      }
    },

    /**
     * Phase 9 groundwork : persiste les absences (blessures/suspensions) d'un event.
     * Désactivé du modèle pour l'instant (feature absence_impact_pondéré calculée plus tard).
     * @param {string|number} eventId
     * @param {Array<{side?:string,team?:string,player:string,position?:string,status?:string,detail?:string}>} rows
     * @param {{source?:string}} [opts]
     */
    savePlayerAbsences(eventId, rows, opts = {}) {
      if (!eventId || !Array.isArray(rows) || !rows.length) return { changes: 0 }
      const now = Date.now()
      const src = opts.source || 'sofascore'
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO player_absences
          (event_id, side, team, player, position, status, detail, source, fetched_at)
         VALUES (@event_id, @side, @team, @player, @position, @status, @detail, @source, @fetched_at)`
      )
      const run = db.transaction((items) => {
        for (const r of items) {
          stmt.run({
            event_id: String(eventId),
            side: r.side || null,
            team: r.team || null,
            player: r.player,
            position: r.position || null,
            status: r.status || null,
            detail: r.detail || null,
            source: src,
            fetched_at: now,
          })
        }
      })
      try {
        run(rows)
        return { changes: rows.length }
      } catch (e) {
        logger.warn(`[DB] savePlayerAbsences failed for ${eventId}: ${e.message}`)
        return { changes: 0 }
      }
    },

    getPlayerAbsences(eventId) {
      try {
        return db.prepare('SELECT * FROM player_absences WHERE event_id = ?').all(String(eventId))
      } catch (e) {
        logger.warn(`[DB] getPlayerAbsences failed for ${eventId}: ${e.message}`)
        return []
      }
    },

    getVisualContext(matchId) {
      try {
        return (
          db
            .prepare('SELECT * FROM visual_context_cache WHERE match_id = ?')
            .get(String(matchId)) || null
        )
      } catch (e) {
        logger.warn(`[DB] getVisualContext failed for ${matchId}: ${e.message}`)
        return null
      }
    },

    setVisualContext(rec) {
      try {
        const now = rec.enriched_at || Date.now()
        db.prepare(
          `INSERT INTO visual_context_cache
             (match_id, screenshot_paths, article_ids, visual_confidence, tiles, scores, query_text, enriched_at, briefing)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(match_id) DO UPDATE SET
             screenshot_paths=excluded.screenshot_paths,
             article_ids=excluded.article_ids,
             visual_confidence=excluded.visual_confidence,
             tiles=excluded.tiles,
             scores=excluded.scores,
             query_text=excluded.query_text,
             enriched_at=excluded.enriched_at,
             briefing=COALESCE(excluded.briefing, visual_context_cache.briefing)`
        ).run(
          String(rec.match_id),
          JSON.stringify(rec.screenshot_paths || []),
          JSON.stringify(rec.article_ids || []),
          Number(rec.visual_confidence || 0),
          JSON.stringify(rec.tiles || []),
          JSON.stringify(rec.scores || []),
          String(rec.query_text || ''),
          now,
          rec.briefing != null ? String(rec.briefing) : null
        )
        return { changes: 1 }
      } catch (e) {
        logger.warn(`[DB] setVisualContext failed for ${rec.match_id}: ${e.message}`)
        return { changes: 0 }
      }
    },
  }
}

module.exports = { createMiscDao }
