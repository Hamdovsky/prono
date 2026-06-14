const { usingPostgres, query } = require('./pg_connector')
const logger = require('./logger')

const pgDb = {
  async exec(sql) {
    await query(sql)
  },

  async query(sql, params = []) {
    try {
      const result = await query(sql, params)
      const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)/i.test(sql.trim())
      if (isMutation) {
        return { rows: [], lastInsertRowid: result.rows?.[0]?.id || null, changes: result.rowCount || 0 }
      }
      return { rows: result.rows || [] }
    } catch (e) {
      logger.error(`[PG DB] query error: ${e.message} | SQL: ${sql.slice(0, 100)}`)
      return { rows: [] }
    }
  },

  async get(sql, params = []) {
    try {
      const result = await query(sql, params)
      return result.rows?.[0] || null
    } catch (e) {
      return null
    }
  },

  prepare(sql) {
    const self = this
    let qIdx = 0
    const pgSql = sql.replace(/\?(?=(?:[^']*'[^']*')*[^']*$)/g, () => `$${++qIdx}`)
    return {
      run: async (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = await query(pgSql, params)
          return { lastInsertRowid: result.rows?.[0]?.id || null, changes: result.rowCount || 0 }
        } catch (e) {
          return { changes: 0 }
        }
      },
      get: async (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = await query(pgSql, params)
          return result.rows?.[0] || null
        } catch (e) {
          return null
        }
      },
      all: async (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = await query(pgSql, params)
          return result.rows || []
        } catch (e) {
          return []
        }
      }
    }
  },

  async insertMatch(m) {
    try {
      const home = (m.homeTeam || '').toString().toLowerCase()
      const away = (m.awayTeam || '').toString().toLowerCase()
      if (home === 'home' || away === 'away') {
        logger.warn(`[PG DB] Skipping match ${m.id} — placeholder team name`)
        return false
      }

      const dataToSave = { ...m }
      delete dataToSave.fullData
      const fullData = JSON.stringify(dataToSave)
      const stats = m.stats || m.statistics || {}

      m.best_odds_home = Math.max(m.odds_home || 0, m.best_odds_home || 0) || m.odds_home || null
      m.best_odds_draw = Math.max(m.odds_draw || 0, m.best_odds_draw || 0) || m.odds_draw || null
      m.best_odds_away = Math.max(m.odds_away || 0, m.best_odds_away || 0) || m.odds_away || null

      const sql = `
        INSERT INTO matches (
          id, "bsd_match_id", "homeTeam", "awayTeam", league, "scoreHome", "scoreAway",
          minute, status, prediction, confidence, "fullData", timestamp, "startTimestamp",
          possession_home, possession_away, dangerous_attacks_home, dangerous_attacks_away,
          shots_on_target_home, shots_on_target_away, corners_home, corners_away,
          source, last_updated, home_win_probability, draw_probability, away_win_probability,
          expected_score, chaos_score, ou_25_prob, btts_prob, xgboost_confidence, news_impact,
          odds_home, odds_draw, odds_away, best_odds_home, best_odds_draw, best_odds_away,
          ev_home, ev_draw, ev_away, ev_best,
          odds_home_open, odds_draw_open, odds_away_open,
          true_prob_home, true_prob_draw, true_prob_away, true_prob_ou25, true_prob_btts,
          clv_value, kelly_stake,
          weather_temp, weather_desc, weather_humidity, home_form_pts, away_form_pts, insufficient_data
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
          $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42,
          $43, $44, $45, $46, $47, $48, $49, $50, $51,
          $52, $53, $54, $55, $56, $57, $58, $59
        ) ON CONFLICT (id) DO UPDATE SET
          "startTimestamp" = COALESCE(EXCLUDED."startTimestamp", matches."startTimestamp"),
          "bsd_match_id" = COALESCE(EXCLUDED."bsd_match_id", matches."bsd_match_id"),
          "scoreHome" = EXCLUDED."scoreHome", "scoreAway" = EXCLUDED."scoreAway",
          minute = EXCLUDED.minute, status = EXCLUDED.status,
          last_updated = EXCLUDED.last_updated, "fullData" = EXCLUDED."fullData",
          prediction = COALESCE(EXCLUDED.prediction, matches.prediction),
          confidence = COALESCE(EXCLUDED.confidence, matches.confidence),
          expected_score = CASE WHEN EXCLUDED.expected_score != '1 - 1' THEN EXCLUDED.expected_score ELSE matches.expected_score END,
          home_win_probability = COALESCE(EXCLUDED.home_win_probability, matches.home_win_probability),
          draw_probability = COALESCE(EXCLUDED.draw_probability, matches.draw_probability),
          away_win_probability = COALESCE(EXCLUDED.away_win_probability, matches.away_win_probability),
          ou_25_prob = COALESCE(EXCLUDED.ou_25_prob, matches.ou_25_prob),
          btts_prob = COALESCE(EXCLUDED.btts_prob, matches.btts_prob),
          ev_home = COALESCE(EXCLUDED.ev_home, matches.ev_home),
          ev_draw = COALESCE(EXCLUDED.ev_draw, matches.ev_draw),
          ev_away = COALESCE(EXCLUDED.ev_away, matches.ev_away),
          kelly_stake = COALESCE(EXCLUDED.kelly_stake, matches.kelly_stake),
          possession_home = EXCLUDED.possession_home, possession_away = EXCLUDED.possession_away,
          dangerous_attacks_home = EXCLUDED.dangerous_attacks_home, dangerous_attacks_away = EXCLUDED.dangerous_attacks_away,
          odds_home = COALESCE(EXCLUDED.odds_home, matches.odds_home),
          odds_draw = COALESCE(EXCLUDED.odds_draw, matches.odds_draw),
          odds_away = COALESCE(EXCLUDED.odds_away, matches.odds_away),
          best_odds_home = COALESCE(EXCLUDED.best_odds_home, matches.best_odds_home),
          best_odds_draw = COALESCE(EXCLUDED.best_odds_draw, matches.best_odds_draw),
          best_odds_away = COALESCE(EXCLUDED.best_odds_away, matches.best_odds_away),
          weather_temp = COALESCE(EXCLUDED.weather_temp, matches.weather_temp),
          weather_desc = COALESCE(EXCLUDED.weather_desc, matches.weather_desc),
          weather_humidity = COALESCE(EXCLUDED.weather_humidity, matches.weather_humidity),
          home_form_pts = COALESCE(EXCLUDED.home_form_pts, matches.home_form_pts),
          away_form_pts = COALESCE(EXCLUDED.away_form_pts, matches.away_form_pts),
          insufficient_data = EXCLUDED.insufficient_data
      `

      const params = [
        m.id, m.bsd_match_id || null, m.homeTeam, m.awayTeam, m.league, m.score?.home ?? 0, m.score?.away ?? 0,
        m.minute || '0', m.status || (m.isLive ? 'live' : 'scheduled'), m.prediction, m.confidence,
        fullData, m.timestamp || new Date().toISOString(),
        m.startTimestamp || null,
        stats.possession?.home || m.possession_home || 0, stats.possession?.away || m.possession_away || 0,
        stats.dangerousAttacks?.home || m.dangerous_attacks_home || 0, stats.dangerousAttacks?.away || m.dangerous_attacks_away || 0,
        stats.totalShots?.home || m.shots_on_target_home || 0, stats.totalShots?.away || m.shots_on_target_away || 0,
        stats.corners?.home || m.corners_home || 0, stats.corners?.away || m.corners_away || 0,
        m.source || 'flashscore', Date.now(),
        m.home_win_probability || 0, m.draw_probability || 0, m.away_win_probability || 0,
        m.expected_score || '1 - 1', m.chaos_score || 50, m.ou_25_prob || 0, m.btts_prob || 0,
        m.xgboost_confidence || 0, m.news_impact || 0,
        m.odds_home || null, m.odds_draw || null, m.odds_away || null,
        m.best_odds_home || null, m.best_odds_draw || null, m.best_odds_away || null,
        m.ev_home || null, m.ev_draw || null, m.ev_away || null, m.ev_best || 'NONE',
        m.odds_home_open || m.odds_home || null, m.odds_draw_open || m.odds_draw || null, m.odds_away_open || m.odds_away || null,
        m.true_prob_home || null, m.true_prob_draw || null, m.true_prob_away || null, m.true_prob_ou25 || null, m.true_prob_btts || null,
        m.clv_value || 0, m.kelly_stake || 0,
        m.weather_temp || 15, m.weather_desc || 'clear sky', m.weather_humidity || 50,
        m.home_form_pts || 0, m.away_form_pts || 0, m.insufficient_data || 0
      ]

      await query(sql, params)
      return m.id
    } catch (err) {
      logger.error(`[PG DB] insertMatch error: ${err.message}`)
      return false
    }
  },

  async getMatchesByStatuses(statuses = []) {
    if (!Array.isArray(statuses) || statuses.length === 0) return []
    try {
      const placeholders = statuses.map((_, i) => `$${i + 1}`).join(',')
      const result = await query(`SELECT * FROM matches WHERE status IN (${placeholders}) ORDER BY timestamp ASC`, statuses)
      return result.rows.map(r => {
        try {
          const parsed = (r.fullData ?? r.fulldata) ? (typeof (r.fullData ?? r.fulldata) === 'string' ? JSON.parse(r.fullData ?? r.fulldata) : (r.fullData ?? r.fulldata)) : {}
          return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league }
        } catch (e) { return r }
      })
    } catch (e) {
      logger.error(`[PG DB] getMatchesByStatuses failed: ${e.message}`)
      return []
    }
  },

  async resolveTeamName(name) {
    if (!name) return null
    const normalized = name.toLowerCase().trim()
      .replace(/%20/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\-]/g, '')
    try {
      const row = await query('SELECT name FROM team_registry WHERE normalized = $1 OR name LIKE $2 LIMIT 1', [normalized, `%${normalized}%`])
      if (row.rows?.[0]) return row.rows[0].name
      await query('INSERT INTO team_registry (name, normalized, last_seen) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET last_seen = $3', [name, normalized, Date.now()])
      return name
    } catch (e) {
      return name
    }
  },

  async getMatchById(id) {
    try {
      const result = await query('SELECT * FROM matches WHERE id = $1', [id])
      const r = result.rows?.[0]
      if (!r) return null
      try {
        const parsed = (r.fullData ?? r.fulldata) ? (typeof (r.fullData ?? r.fulldata) === 'string' ? JSON.parse(r.fullData ?? r.fulldata) : (r.fullData ?? r.fulldata)) : {}
        return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league }
      } catch (e) { return r }
    } catch (err) {
      return null
    }
  },

  async updatePredictions(matchId, data) {
    try {
      const result = await query('SELECT "fullData" FROM matches WHERE id = $1', [matchId])
      const row = result.rows?.[0]
      if (!row) return false

      let fullData = (row.fullData ?? row.fulldata) ? (typeof (row.fullData ?? row.fulldata) === 'string' ? JSON.parse(row.fullData ?? row.fulldata) : (row.fullData ?? row.fulldata)) : {}
      
      // DEBUG: log what's coming in
      console.log(`[UPDATE_PRED] ${matchId} incoming data keys:`, Object.keys(data))
      console.log(`[UPDATE_PRED] ${matchId} data.ai_source:`, data.ai_source)
      console.log(`[UPDATE_PRED] ${matchId} data.home_win_probability:`, data.home_win_probability)
      console.log(`[UPDATE_PRED] ${matchId} data.expected_score:`, data.expected_score)
      console.log(`[UPDATE_PRED] ${matchId} data.enriched keys:`, data.enriched ? Object.keys(data.enriched) : 'none')
      
      const enriched = data.enriched || (data.home_win_probability ? data : null)
      fullData = { ...fullData, ...data, enriched: enriched ? { ...(fullData.enriched || {}), ...enriched } : fullData.enriched, last_updated: Date.now() }
      
      // DEBUG: log what's in fullData after merge
      console.log(`[UPDATE_PRED] ${matchId} fullData.ai_source after merge:`, fullData.ai_source)
      console.log(`[UPDATE_PRED] ${matchId} fullData.home_win_probability after merge:`, fullData.home_win_probability)
      
      if (enriched) {
        fullData.home_win_probability = enriched.home_win_probability || fullData.home_win_probability
        fullData.draw_probability = enriched.draw_probability || fullData.draw_probability
        fullData.away_win_probability = enriched.away_win_probability || fullData.away_win_probability
        fullData.master_v20 = enriched.master_v20 || fullData.master_v20
      }
      delete fullData.id
      delete fullData.fullData
      if (fullData.enriched?.enriched) delete fullData.enriched.enriched

      const verdict = data.verdict || (data.enriched?.verdict) || data.prediction || 'RISKY BET'
      const hProb = parseFloat(data.home_win_probability || enriched?.home_win_probability || fullData.home_win_probability || 0)
      const dProb = parseFloat(data.draw_probability || enriched?.draw_probability || fullData.draw_probability || 0)
      const aProb = parseFloat(data.away_win_probability || enriched?.away_win_probability || fullData.away_win_probability || 0)
      const ou25 = parseFloat(data.ou_25_prob || enriched?.ou_25_prob || data.ou_2_5_prob || 0)
      const bttsp = parseFloat(data.btts_prob || enriched?.btts_prob || 0)
      const expScr = data.expected_score || enriched?.expected_score || fullData.expected_score || null
      const conf = parseFloat(data.confidence || enriched?.confidence || data.v22_success_rate || 0)
      const xgbConf = parseFloat(data.xgboost_confidence || enriched?.xgboost_confidence || 0)

      const sql = `
        UPDATE matches SET
          fullData = $1, prediction = $2, last_updated = $3,
          home_win_probability = CASE WHEN $4 > 0 THEN $4 ELSE home_win_probability END,
          draw_probability = CASE WHEN $5 > 0 THEN $5 ELSE draw_probability END,
          away_win_probability = CASE WHEN $6 > 0 THEN $6 ELSE away_win_probability END,
          ou_25_prob = CASE WHEN $7 > 0 THEN $7 ELSE ou_25_prob END,
          btts_prob = CASE WHEN $8 > 0 THEN $8 ELSE btts_prob END,
          expected_score = CASE WHEN $9 IS NOT NULL THEN $9 ELSE expected_score END,
          confidence = CASE WHEN $10 > 0 THEN $10 ELSE confidence END,
          xgboost_confidence = CASE WHEN $11 > 0 THEN $11 ELSE xgboost_confidence END,
          ev_home = CASE WHEN $12 IS NOT NULL THEN $12 ELSE ev_home END,
          ev_draw = CASE WHEN $13 IS NOT NULL THEN $13 ELSE ev_draw END,
          ev_away = CASE WHEN $14 IS NOT NULL THEN $14 ELSE ev_away END,
          kelly_stake = CASE WHEN $15 > 0 THEN $15 ELSE kelly_stake END,
          true_prob_home = CASE WHEN $16 > 0 THEN $16 ELSE true_prob_home END,
          true_prob_draw = CASE WHEN $17 > 0 THEN $17 ELSE true_prob_draw END,
          true_prob_away = CASE WHEN $18 > 0 THEN $18 ELSE true_prob_away END,
          weather_temp = CASE WHEN $19 IS NOT NULL THEN $19 ELSE weather_temp END,
          weather_humidity = CASE WHEN $20 IS NOT NULL THEN $20 ELSE weather_humidity END,
          home_form_pts = CASE WHEN $21 IS NOT NULL THEN $21 ELSE home_form_pts END,
          away_form_pts = CASE WHEN $22 IS NOT NULL THEN $22 ELSE away_form_pts END,
          motivation_signature = $23
        WHERE id = $24
      `

      await query(sql, [
        JSON.stringify(fullData), verdict, Date.now(),
        hProb, dProb, aProb, ou25, bttsp, expScr, conf, xgbConf,
        data.ev_home ?? null, data.ev_draw ?? null, data.ev_away ?? null,
        data.kelly_stake || 0, data.true_prob_home || 0, data.true_prob_draw || 0, data.true_prob_away || 0,
        data.weather_temp ?? null, data.weather_humidity ?? null, data.home_form_pts ?? null, data.away_form_pts ?? null,
        data.motivation_signature || enriched?.motivation_signature || 'Logique Standard',
        matchId
      ])

      const histSql = `
        INSERT INTO prediction_history (match_id, league, prediction_type, prediction_val, probability, status, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT(match_id, prediction_type) DO UPDATE SET
          probability = EXCLUDED.probability, prediction_val = EXCLUDED.prediction_val
      `
      await query(histSql, [matchId, fullData.league, 'Home', 'Win', hProb / 100, 'pending'])
      await query(histSql, [matchId, fullData.league, 'Away', 'Win', aProb / 100, 'pending'])
      await query(histSql, [matchId, fullData.league, 'Draw', 'Draw', dProb / 100, 'pending'])

      logger.info(`[PG DB] AI Enrichment persisted for ${matchId} — Home:${hProb.toFixed(1)}% Draw:${dProb.toFixed(1)}% Away:${aProb.toFixed(1)}%`)
      return true
    } catch (e) {
      logger.error(`[PG DB] updatePredictions failed for ${matchId}: ${e.message}`)
      return false
    }
  },

  async getLatestMatchTimestamp() {
    try {
      const result = await query('SELECT MAX(timestamp) as lastupdate FROM matches')
      return result.rows?.[0]?.lastupdate || null
    } catch { return null }
  },

  getLeagueAverages: async () => ({ avgTotalGoals: 2.7, avgHomeGoals: 1.5, avgAwayGoals: 1.2, matchCount: 0 }),

  async getAllLeaguesConfig() {
    try {
      const result = await query('SELECT * FROM leagues_config ORDER BY tier ASC, name ASC')
      return result.rows || []
    } catch { return [] }
  },

  insertPlayerStat: async () => true,
  getPlayerStatsByTeam: async () => [],
  insertVisionLog: async () => true,

  async getHighImpactScheduledMatches() {
    try {
      const result = await query(`SELECT * FROM matches WHERE status = 'scheduled' AND "fullData" IS NOT NULL ORDER BY timestamp ASC LIMIT 20`)
      return result.rows.map(r => {
        try { const parsed = JSON.parse((r.fullData ?? r.fulldata) || '{}'); return { ...r, ...parsed } }
        catch { return r }
      })
    } catch { return [] }
  },

  async getNewsPrecisionHistory() {
    try {
      const result = await query(`SELECT "homeTeam", "awayTeam", status, "scoreHome", "scoreAway", "fullData" FROM matches WHERE status IN ('FT', 'finished', 'Finished') ORDER BY timestamp DESC LIMIT 30`)
      let total = 0, hits = 0
      const matches = []
      for (const r of result.rows) {
        const data = JSON.parse((r.fullData ?? r.fulldata) || '{}')
        const pronos = (data.enriched?.main_predictions) ? data.enriched.main_predictions : (data.predictions || [])
        if (pronos.length === 0) continue
        total++
        const actual = (r.scoreHome ?? r.scorehome) > (r.scoreAway ?? r.scoreaway) ? 'H' : (r.scoreHome ?? r.scorehome) < (r.scoreAway ?? r.scoreaway) ? 'A' : 'D'
        let success = false
        pronos.forEach(p => {
          const val = (p.val || '').toLowerCase()
          if ((val.includes('home') || val.includes('🏠') || val.includes('1')) && actual === 'H') success = true
          else if ((val.includes('away') || val.includes('✈️') || val.includes('2')) && actual === 'A') success = true
          else if ((val.includes('draw') || val.includes('x')) && actual === 'D') success = true
        })
        if (success) hits++
        matches.push({ id: Math.random().toString(), homeTeam: r.homeTeam, awayTeam: r.awayTeam, impact: 'High', success })
      }
      return { total, accuracy: total > 0 ? Math.round((hits / total) * 100) : 0, matches: matches.slice(0, 10) }
    } catch { return { total: 0, accuracy: 0, matches: [] } }
  },

  seedLeagues: async () => true,
  getTeamMatchHistory: async () => [],

  async archiveFinishedMatches() {
    try {
      const finished = await query(`SELECT * FROM matches WHERE status IN ('FT', 'finished', 'Finished', 'Ended')`)
      if (finished.rows.length === 0) return { success: true, archivedCount: 0 }

      let count = 0
      for (const r of finished.rows) {
        const sh = (r.scoreHome ?? r.scorehome) ?? 0, sa = (r.scoreAway ?? r.scoreaway) ?? 0
        await query(
          `INSERT INTO historical_matches (id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", league, "fullData", timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [r.id, r.homeTeam, r.awayTeam, sh, sa, r.league, (r.fullData ?? r.fulldata) || '{}', r.timestamp || new Date().toISOString()]
        )
        await query(
          `UPDATE prediction_history SET status = 'finished', result = CASE WHEN (($1 > $2 AND prediction_type = 'Home') OR ($1 < $2 AND prediction_type = 'Away') OR ($1 = $2 AND prediction_type = 'Draw')) THEN 'won' ELSE 'lost' END WHERE match_id = $3`,
          [sh, sa, r.id]
        )
        await query('DELETE FROM matches WHERE id = $1', [r.id])
        count++
      }
      logger.info(`[PG DB] Archived ${count} matches to historical_matches`)
      return { success: true, archivedCount: count }
    } catch (e) {
      logger.error(`[PG DB] Archive failed: ${e.message}`)
      return { success: false, error: e.message }
    }
  },

  insertSnapshot: async () => true,
  getSnapshotBefore: async () => null,

  async logLivePrediction(snapshot) {
    try {
      const sql = `
        INSERT INTO live_prediction_logs (match_id, home_team, away_team, league, minute, score_home, score_away,
          prediction_next5, prediction_next10, prediction_next15, home_xg, away_xg,
          home_shots_on_target, away_shots_on_target, home_corners, away_corners, home_possession, alert_level, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id
      `
      const result = await query(sql, [
        snapshot.matchId, snapshot.homeTeam, snapshot.awayTeam, snapshot.league,
        snapshot.minute, snapshot.scoreHome, snapshot.scoreAway,
        snapshot.predNext5, snapshot.predNext10, snapshot.predNext15,
        snapshot.homeXg || 0, snapshot.awayXg || 0, snapshot.homeSot || 0, snapshot.awaySot || 0,
        snapshot.homeCorners || 0, snapshot.awayCorners || 0, snapshot.homePossession || 50,
        snapshot.alertLevel || 'NORMAL', snapshot.source || 'unknown'
      ])
      return result.rows?.[0]?.id || null
    } catch (e) {
      logger.error(`[PG DB] logLivePrediction failed: ${e.message}`)
      return null
    }
  },

  async updateLivePredictionOutcomes(matchId, finalScoreHome, finalScoreAway) {
    try {
      const logs = await query(
        `SELECT id, minute, score_home, score_away FROM live_prediction_logs WHERE match_id = $1 AND outcome_checked = 0 ORDER BY minute ASC`,
        [matchId]
      )
      for (const log of logs.rows) {
        const goalNext5 = finalScoreHome + finalScoreAway > (log.score_home || 0) + (log.score_away || 0) ? 1 : 0
        await query(
          `UPDATE live_prediction_logs SET actual_goal_next5 = $1, actual_goal_next10 = $1, actual_goal_next15 = $1,
           actual_final_home = $2, actual_final_away = $3, outcome_checked = 1, checked_at = NOW() WHERE id = $4`,
          [goalNext5, finalScoreHome, finalScoreAway, log.id]
        )
      }
      if (logs.rows.length > 0) logger.info(`[PG DB] Updated ${logs.rows.length} live prediction outcomes for match ${matchId}`)
      return logs.rows.length
    } catch (e) {
      logger.error(`[PG DB] updateLivePredictionOutcomes failed: ${e.message}`)
      return 0
    }
  },

  async getLivePredictionsForTraining(limit = 5000) {
    try {
      const result = await query(`SELECT * FROM live_prediction_logs WHERE outcome_checked = 1 AND actual_goal_next5 IS NOT NULL ORDER BY created_at DESC LIMIT $1`, [limit])
      return result.rows || []
    } catch { return [] }
  },

  async getUncheckedLivePredictions() {
    try {
      const result = await query(`SELECT DISTINCT match_id FROM live_prediction_logs WHERE outcome_checked = 0`)
      return result.rows || []
    } catch { return [] }
  },

  async insertPattern(match) {
    try {
      const scoreStr = `${match.scoreHome || 0}-${match.scoreAway || 0}`
      const result = match.status === 'finished' ? 'WIN' : 'UNKNOWN'
      await query(
        `INSERT INTO winning_patterns (match_id, league, "homeTeam", "awayTeam", prediction, result, score, "fullData") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [match.id, match.league, match.homeTeam, match.awayTeam, match.prediction || 'N/A', result, scoreStr, (match.fullData ?? match.fulldata) || JSON.stringify(match)]
      )
      return true
    } catch (e) {
      logger.error(`[PG DB] insertPattern failed: ${e.message}`)
      return false
    }
  },

  async getAllPatterns(limit = 100) {
    try {
      const result = await query(`SELECT * FROM winning_patterns ORDER BY timestamp DESC LIMIT $1`, [limit])
      return result.rows || []
    } catch { return [] }
  },

  getUpcomingPredictions: async () => [],
  insertPrediction: async (p) => p.id,

  async getMatchesByStatus(status) {
    try {
      const parsedStatus = status === 'live' ? 'live' : (status === 'scheduled' ? 'scheduled' : status)
      const result = await query(`SELECT * FROM matches WHERE status = $1 ORDER BY timestamp ASC`, [parsedStatus])
      return result.rows.map(r => {
        try {
          const parsed = (r.fullData ?? r.fulldata) ? (typeof (r.fullData ?? r.fulldata) === 'string' ? JSON.parse(r.fullData ?? r.fulldata) : (r.fullData ?? r.fulldata)) : {}
          return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league }
        } catch (e) { return r }
      })
    } catch (e) {
      logger.error(`[PG DB] getMatchesByStatus failed: ${e.message}`)
      return []
    }
  },

  async cleanupStaleMatches() {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const result = await query(`DELETE FROM matches WHERE timestamp < $1 AND status NOT IN ('live', '1H', '2H', 'HT')`, [oneDayAgo])
      if (result.rowCount > 0) logger.info(`[PG DB] Cleaned up ${result.rowCount} stale matches`)
      return result.rowCount || 0
    } catch (e) {
      logger.error(`[PG DB] Cleanup failed: ${e.message}`)
      return 0
    }
  },

  async maintenance() {
    try {
      logger.info('[PG DB] Running maintenance (ANALYZE)...')
      await query('ANALYZE')
      logger.info('[PG DB] Maintenance complete')
      return true
    } catch (e) {
      logger.error(`[PG DB] Maintenance error: ${e.message}`)
      return false
    }
  },

  async getAllMatches() {
    try {
      const result = await query('SELECT * FROM matches ORDER BY timestamp ASC')
      return result.rows.map(r => {
        try {
          const parsed = (r.fullData ?? r.fulldata) ? (typeof (r.fullData ?? r.fulldata) === 'string' ? JSON.parse(r.fullData ?? r.fulldata) : (r.fullData ?? r.fulldata)) : {}
          return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league }
        } catch (e) { return r }
      })
    } catch { return [] }
  },

  async getMatchesByDate(dateStr) {
    try {
      const result = await query(`SELECT * FROM matches WHERE timestamp LIKE $1 ORDER BY timestamp ASC`, [`${dateStr}%`])
      return result.rows.map(r => {
        try {
          const parsed = (r.fullData ?? r.fulldata) ? (typeof (r.fullData ?? r.fulldata) === 'string' ? JSON.parse(r.fullData ?? r.fulldata) : (r.fullData ?? r.fulldata)) : {}
          return { ...r, ...parsed, id: r.id, homeTeam: r.homeTeam || parsed.homeTeam, awayTeam: r.awayTeam || parsed.awayTeam, league: r.league || parsed.league }
        } catch (e) { return r }
      })
    } catch { return [] }
  },

  cleanupPlaceholderTeams: async () => 0
}

// Backward compatibility: code that uses `database.db.prepare(...)` or `database.db.query(...)`
pgDb.db = {
  prepare: (sql) => pgDb.prepare(sql),
  query: (sql, params) => pgDb.query(sql, params),
  get: (sql, params) => pgDb.get(sql, params),
  exec: (sql) => pgDb.exec(sql),
  on: () => {}, // LISTEN/NOTIFY not needed; silent no-op
  transaction: (fn) => fn, // Simple wrapper
}

module.exports = pgDb
