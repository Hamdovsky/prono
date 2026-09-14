// createPredictionsDao — extrait de core/database.js (split 2026-09-07, découpe scriptée, contenu verbatim).
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

function createPredictionsDao(db) {
  return {
    updatePredictions: async (matchId, data) => {
      try {
        const row = db.prepare('SELECT fullData FROM matches WHERE id = ?').get(matchId)
        if (!row) return false

        let fullData = row.fullData
          ? typeof row.fullData === 'string'
            ? JSON.parse(row.fullData)
            : row.fullData
          : {}

        // Ensure we have a clean enriched object
        const enriched = data.enriched || (data.home_win_probability ? data : null)

        fullData = {
          ...fullData,
          ...data,
          enriched: enriched ? { ...(fullData.enriched || {}), ...enriched } : fullData.enriched,
          last_updated: Date.now(),
        }

        // If data was already enriched, flatten important fields to top level for DB queries
        if (enriched) {
          fullData.home_win_probability =
            enriched.home_win_probability || fullData.home_win_probability
          fullData.draw_probability = enriched.draw_probability || fullData.draw_probability
          fullData.away_win_probability =
            enriched.away_win_probability || fullData.away_win_probability
          fullData.master_v20 = enriched.master_v20 || fullData.master_v20
        }

        delete fullData.id
        delete fullData.fullData
        if (fullData.enriched && fullData.enriched.enriched) delete fullData.enriched.enriched

        const rawVerdict =
          data.prediction || (data.enriched && data.enriched.prediction) || data.verdict || null
        // Audit P4 : politique marchés (masquage réversible du 1X2 pur)
        const verdictPolicy = applyMarketPolicy(rawVerdict, {
          home_win_probability:
            data.home_win_probability ??
            enriched?.home_win_probability ??
            fullData.home_win_probability,
          away_win_probability:
            data.away_win_probability ??
            enriched?.away_win_probability ??
            fullData.away_win_probability,
        })
        const verdict = verdictPolicy.converted ? verdictPolicy.prediction : rawVerdict
        if (verdictPolicy.converted) {
          logger.info(
            `[MARKET_POLICY] ${matchId} ${verdictPolicy.originalPrediction} -> ${verdict} (DISABLE_PURE_1X2)`
          )
          data.originalPrediction = verdictPolicy.originalPrediction
          data.prediction = verdict
          // Audit A0 : le fullData ci-dessus a été construit AVANT ce hook —
          // réinjecter le verdict original (invariant set-if-absent).
          if (!fullData.originalPrediction) {
            fullData.originalPrediction = verdictPolicy.originalPrediction
          }
        }

        // Extract scalar values to write into indexed SQLite columns
        // Use null when no source provides a value (allows clearing)
        const hProb =
          data.home_win_probability !== undefined
            ? parseFloat(data.home_win_probability)
            : enriched?.home_win_probability !== undefined
              ? parseFloat(enriched.home_win_probability)
              : fullData.home_win_probability !== undefined
                ? parseFloat(fullData.home_win_probability)
                : null
        const dProb =
          data.draw_probability !== undefined
            ? parseFloat(data.draw_probability)
            : enriched?.draw_probability !== undefined
              ? parseFloat(enriched.draw_probability)
              : fullData.draw_probability !== undefined
                ? parseFloat(fullData.draw_probability)
                : null
        const aProb =
          data.away_win_probability !== undefined
            ? parseFloat(data.away_win_probability)
            : enriched?.away_win_probability !== undefined
              ? parseFloat(enriched.away_win_probability)
              : fullData.away_win_probability !== undefined
                ? parseFloat(fullData.away_win_probability)
                : null
        const ou25 =
          data.ou_25_prob !== undefined
            ? parseFloat(data.ou_25_prob)
            : enriched?.ou_25_prob !== undefined
              ? parseFloat(enriched.ou_25_prob)
              : data.ou_2_5_prob !== undefined
                ? parseFloat(data.ou_2_5_prob)
                : null
        const bttsp =
          data.btts_prob !== undefined
            ? parseFloat(data.btts_prob)
            : enriched?.btts_prob !== undefined
              ? parseFloat(enriched.btts_prob)
              : null
        // Audit BT1 (2026-08-24) : dérivation + persistance du pick BTTS au temps T
        const bttsDeriv = deriveBttsPick({
          quant: fullData.quant || enriched?.quant || null,
          btts_prob: bttsp,
        })
        if (bttsDeriv.bttsPick) {
          data.btts_pick = bttsDeriv.bttsPick
          fullData.btts_pick = bttsDeriv.bttsPick
          fullData.btts_pick_prob = bttsDeriv.bttsProb
        }
        // Audit Q1 : dérivation + persistance des picks Corners / HT au temps T
        const cornerDeriv = deriveCornerPick({
          quant: fullData.quant || enriched?.quant || null,
          expected_corners:
            data.expected_corners ??
            enriched?.expected_corners ??
            fullData.expected_corners ??
            null,
        })
        if (cornerDeriv.cornerPick) {
          data.corner_pick = cornerDeriv.cornerPick
          fullData.corner_pick = cornerDeriv.cornerPick
          fullData.corner_pick_prob = cornerDeriv.cornerProb
        }
        const htDeriv = deriveHTPick({
          quant: fullData.quant || enriched?.quant || null,
          ht_goal_prob:
            data.ht_goal_prob ?? enriched?.ht_goal_prob ?? fullData.ht_goal_prob ?? null,
          league: fullData.league ?? enriched?.league ?? data.league ?? null,
          expected_score:
            data.expected_score ?? enriched?.expected_score ?? fullData.expected_score ?? null,
          expected_total_goals:
            data.expected_total_goals ?? enriched?.expected_total_goals ?? fullData.expected_total_goals ?? null,
        })
        if (htDeriv.htPick) {
          data.ht_pick = htDeriv.htPick
          fullData.ht_pick = htDeriv.htPick
          fullData.ht_pick_prob = htDeriv.htProb
        }
        const expScr =
          data.expected_score || enriched?.expected_score || fullData.expected_score || null
        const conf =
          data.confidence !== undefined
            ? parseFloat(data.confidence)
            : enriched?.confidence !== undefined
              ? parseFloat(enriched.confidence)
              : data.v22_success_rate !== undefined
                ? parseFloat(data.v22_success_rate)
                : null
        const xgbConf =
          data.xgboost_confidence !== undefined
            ? parseFloat(data.xgboost_confidence)
            : enriched?.xgboost_confidence !== undefined
              ? parseFloat(enriched.xgboost_confidence)
              : null

        // ⚡ Write BOTH fullData JSON AND individual indexed columns
        const sql = `
                  UPDATE matches SET 
                      "fullData" = ?,
                      prediction = ?,
                      last_updated = ?,
                      "home_win_probability" = CASE WHEN ? IS NOT NULL THEN ? ELSE "home_win_probability" END,
                      "draw_probability"     = CASE WHEN ? IS NOT NULL THEN ? ELSE "draw_probability" END,
                      "away_win_probability" = CASE WHEN ? IS NOT NULL THEN ? ELSE "away_win_probability" END,
                      "ou_25_prob"           = CASE WHEN ? IS NOT NULL THEN ? ELSE "ou_25_prob" END,
                      "btts_prob"            = CASE WHEN ? IS NOT NULL THEN ? ELSE "btts_prob" END,
                      "expected_score"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "expected_score" END,
                      confidence           = CASE WHEN ? IS NOT NULL THEN ? ELSE confidence END,
                      "xgboost_confidence"   = CASE WHEN ? IS NOT NULL THEN ? ELSE "xgboost_confidence" END,
                      "ev_home"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_home" END,
                      "ev_draw"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_draw" END,
                      "ev_away"              = CASE WHEN ? IS NOT NULL THEN ? ELSE "ev_away" END,
                      "kelly_stake"          = CASE WHEN ? IS NOT NULL THEN ? ELSE "kelly_stake" END,
                      "true_prob_home"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_home" END,
                      "true_prob_draw"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_draw" END,
                      "true_prob_away"       = CASE WHEN ? IS NOT NULL THEN ? ELSE "true_prob_away" END,
                      "weather_temp"         = CASE WHEN ? IS NOT NULL THEN ? ELSE "weather_temp" END,
                      "weather_humidity"     = CASE WHEN ? IS NOT NULL THEN ? ELSE "weather_humidity" END,
                      "home_form_pts"        = CASE WHEN ? IS NOT NULL THEN ? ELSE "home_form_pts" END,
                      "away_form_pts"        = CASE WHEN ? IS NOT NULL THEN ? ELSE "away_form_pts" END,
                      "odds_home"            = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_home" END,
                      "odds_draw"            = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_draw" END,
                      "odds_away"            = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_away" END,
                      "odds_over25"          = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_over25" END,
                      "odds_under25"         = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_under25" END,
                      "odds_btts_yes"        = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_btts_yes" END,
                      "odds_btts_no"         = CASE WHEN ? IS NOT NULL THEN ? ELSE "odds_btts_no" END,
                      "motivation_signature" = ?,
                      "insufficient_data" = CASE WHEN ? IS NOT NULL THEN ? ELSE 0 END
                  WHERE id = ?
              `

        const params = [
          JSON.stringify(fullData),
          verdict,
          Date.now(),
          hProb,
          hProb,
          dProb,
          dProb,
          aProb,
          aProb,
          ou25,
          ou25,
          bttsp,
          bttsp,
          expScr,
          expScr,
          conf,
          conf,
          xgbConf,
          xgbConf,
          data.ev_home ?? null,
          data.ev_home ?? null,
          data.ev_draw ?? null,
          data.ev_draw ?? null,
          data.ev_away ?? null,
          data.ev_away ?? null,
          data.kelly_stake ?? null,
          data.kelly_stake ?? null,
          data.true_prob_home ?? null,
          data.true_prob_home ?? null,
          data.true_prob_draw ?? null,
          data.true_prob_draw ?? null,
          data.true_prob_away ?? null,
          data.true_prob_away ?? null,
          data.weather_temp ?? null,
          data.weather_temp ?? null,
          data.weather_humidity ?? null,
          data.weather_humidity ?? null,
          data.home_form_pts ?? null,
          data.home_form_pts ?? null,
          data.away_form_pts ?? null,
          data.away_form_pts ?? null,
          data.odds_home ?? null,
          data.odds_home ?? null,
          data.odds_draw ?? null,
          data.odds_draw ?? null,
          data.odds_away ?? null,
          data.odds_away ?? null,
          data.odds_over25 ?? null,
          data.odds_over25 ?? null,
          data.odds_under25 ?? null,
          data.odds_under25 ?? null,
          data.odds_btts_yes ?? null,
          data.odds_btts_yes ?? null,
          data.odds_btts_no ?? null,
          data.odds_btts_no ?? null,
          data.motivation_signature || enriched?.motivation_signature || 'Logique Standard',
          data.insufficient_data ?? null,
          data.insufficient_data ?? null,
          matchId,
        ]

        // 🛡️ [STABILITY] Atomic transaction + Retry for SQLite "Database is locked"
        const histSql = `
                  INSERT INTO prediction_history (match_id, league, prediction_type, prediction_val, probability, status, timestamp)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(match_id, prediction_type) DO UPDATE SET
                  probability = excluded.probability,
                  prediction_val = excluded.prediction_val
              `
        const updateTransaction = db.transaction(() => {
          db.prepare(sql).run(params)
          if (hProb > 0)
            db.prepare(histSql).run(
              matchId,
              fullData.league,
              'Home',
              'Win',
              hProb / 100,
              'pending',
              Date.now()
            )
          if (aProb > 0)
            db.prepare(histSql).run(
              matchId,
              fullData.league,
              'Away',
              'Win',
              aProb / 100,
              'pending',
              Date.now()
            )
          if (dProb > 0)
            db.prepare(histSql).run(
              matchId,
              fullData.league,
              'Draw',
              'Draw',
              dProb / 100,
              'pending',
              Date.now()
            )
        })

        let attempts = 0
        while (attempts < 3) {
          try {
            updateTransaction()
            logger.info(
              `✅ [DB] AI Enrichment persisted for ${matchId} — Home:${(hProb ?? 0).toFixed(1)}% Draw:${(dProb ?? 0).toFixed(1)}% Away:${(aProb ?? 0).toFixed(1)}%`
            )
            return true
          } catch (err) {
            attempts++
            if (err.message.includes('busy') || err.message.includes('locked')) {
              logger.warn(`⚠️ [DB] Database busy, retry ${attempts}/3 for ${matchId}...`)
              await new Promise((r) => setTimeout(r, 500 * attempts))
            } else {
              logger.error(
                `❌ [DB] updatePredictions transaction failed for ${matchId}: ${err.message}`
              )
              return false
            }
          }
        }
        return false
      } catch (e) {
        logger.error(`❌ [DB] updatePredictions failed for ${matchId}: ${e.message}`)
        return false
      }
    },

    // ─── ÉCRITURE COTES HONNÊTES (dataFusionService.fetchOdds) ─────────
    // Petit writer dédié aux colonnes odds (home/draw/away + source + erreur).
    // Ne touche JAMAIS aux prédictions (contrairement à updatePredictions qui
    // exige fullData+verdict). Permet de tracer dans matches le résultat de la
    // récupération réelle: réussite → odds_source='betexplorer'; échec →
    // odds_source=null + odds_fetch_error=raison.
    insertSnapshot: async (matchId, minute, stats) => {
      return true
    },
    getSnapshotBefore: async (matchId, beforeTimestamp) => {
      return null
    },

    // ── LIVE PREDICTION LOGGING ────────────────────────────────────
    logLivePrediction: async (snapshot) => {
      try {
        const sql = `
                  INSERT INTO live_prediction_logs
                      (match_id, home_team, away_team, league, minute, score_home, score_away,
                       prediction_next5, prediction_next10, prediction_next15,
                       home_xg, away_xg, home_shots_on_target, away_shots_on_target,
                       home_corners, away_corners, home_possession, alert_level, source)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `
        const res = db
          .prepare(sql)
          .run(
            snapshot.matchId,
            snapshot.homeTeam,
            snapshot.awayTeam,
            snapshot.league,
            snapshot.minute,
            snapshot.scoreHome,
            snapshot.scoreAway,
            snapshot.predNext5,
            snapshot.predNext10,
            snapshot.predNext15,
            snapshot.homeXg || 0,
            snapshot.awayXg || 0,
            snapshot.homeSot || 0,
            snapshot.awaySot || 0,
            snapshot.homeCorners || 0,
            snapshot.awayCorners || 0,
            snapshot.homePossession || 50,
            snapshot.alertLevel || 'NORMAL',
            snapshot.source || 'unknown'
          )
        return res.lastInsertRowid
      } catch (e) {
        logger.error(`[DB] logLivePrediction failed: ${e.message}`)
        return null
      }
    },

    updateLivePredictionOutcomes: async (matchId, finalScoreHome, finalScoreAway) => {
      try {
        const logs = db
          .prepare(
            `SELECT id, minute, score_home, score_away FROM live_prediction_logs
                   WHERE match_id = ? AND outcome_checked = 0 ORDER BY minute ASC`
          )
          .all(matchId)

        for (const log of logs) {
          const next5goal = log.minute + 5
          const next10goal = log.minute + 10
          const next15goal = log.minute + 15

          const actualGoalMinute = null // Unknown without granular live data
          const goalNext5 =
            finalScoreHome + finalScoreAway > log.score_home + log.score_away ? 1 : 0
          const goalNext10 = goalNext5
          const goalNext15 = goalNext5

          db.prepare(
            `
                      UPDATE live_prediction_logs SET
                          actual_goal_next5 = ?,
                          actual_goal_next10 = ?,
                          actual_goal_next15 = ?,
                          actual_final_home = ?,
                          actual_final_away = ?,
                          outcome_checked = 1,
                          checked_at = datetime('now')
                      WHERE id = ?
                  `
          ).run(goalNext5, goalNext10, goalNext15, finalScoreHome, finalScoreAway, log.id)
        }

        if (logs.length > 0) {
          logger.info(`[DB] Updated ${logs.length} live prediction outcomes for match ${matchId}`)
        }
        return logs.length
      } catch (e) {
        logger.error(`[DB] updateLivePredictionOutcomes failed: ${e.message}`)
        return 0
      }
    },

    getLivePredictionsForTraining: async (limit = 5000) => {
      try {
        return db
          .prepare(
            `
                  SELECT * FROM live_prediction_logs
                  WHERE outcome_checked = 1 AND actual_goal_next5 IS NOT NULL
                  ORDER BY created_at DESC LIMIT ?
              `
          )
          .all(limit)
      } catch (e) {
        logger.error(`[DB] getLivePredictionsForTraining failed: ${e.message}`)
        return []
      }
    },

    getUncheckedLivePredictions: async () => {
      try {
        return db
          .prepare(`SELECT DISTINCT match_id FROM live_prediction_logs WHERE outcome_checked = 0`)
          .all()
      } catch (e) {
        return []
      }
    },
    insertPattern: async (match) => {
      try {
        const sql = `
                  INSERT INTO winning_patterns (match_id, league, homeTeam, awayTeam, prediction, result, score, fullData)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `
        const result = match.status === 'finished' ? 'WIN' : 'UNKNOWN'
        const scoreStr = `${match.scoreHome}-${match.scoreAway}`

        db.prepare(sql).run(
          match.id,
          match.league,
          match.homeTeam,
          match.awayTeam,
          match.prediction || 'N/A',
          result,
          scoreStr,
          match.fullData || JSON.stringify(match)
        )
        return true
      } catch (e) {
        logger.error(`❌ [DB] insertPattern failed: ${e.message}`)
        return false
      }
    },
    getAllPatterns: async (limit = 100) => {
      try {
        return db
          .prepare('SELECT * FROM winning_patterns ORDER BY timestamp DESC LIMIT ?')
          .all(limit)
      } catch (e) {
        return []
      }
    },
    getUpcomingPredictions: async () => {
      return []
    },
    insertPrediction: async (p) => {
      return p.id
    },
  }
}

module.exports = { createPredictionsDao }
