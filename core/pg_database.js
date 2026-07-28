const path = require('path')
const fs = require('fs')
const { usingPostgres, query } = require('./pg_connector')
const logger = require('./logger')

function sqliteToPg(sql) {
  return sql
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bINSERT\s+OR\s+ABORT\s+INTO\b/gi, 'INSERT INTO')
    .replace(/json_extract\s*\(\s*("[^"]+"|\w+)\s*,\s*'\$\.([^']+)'\s*\)/g, (match, col, path) => {
      const parts = path.split('.')
      const colClean = col.startsWith('"') ? col : `"${col}"`
      return `${colClean}::jsonb #>> '{${parts.join(',')}}'`
    })
    .replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\bCURRENT_TIMESTAMP\b/gi, 'NOW()')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ')
    .replace(/'[^']*'|(?<!")\b([a-z]+[A-Z]\w*)\b(?!")/g, (m, g1) =>
      g1 === undefined ? m : `"${g1}"`
    )
}

// ── Synchronous query worker (compatibility layer for db.prepare().all/get/run) ──
const { Worker } = require('worker_threads')

const PG_SYNC_TIMEOUT_MS = 5000

let syncWorker = null
let _queryIdCounter = 0
const _SYNC_FLAG = new Int32Array(new SharedArrayBuffer(4))
let _syncResult = null

function _getSyncWorker() {
  if (syncWorker) return syncWorker
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_URL
  if (!dbUrl) return null

  syncWorker = new Worker(path.join(__dirname, 'syncQueryWorker.js'), {
    workerData: { databaseUrl: dbUrl, sab: _SYNC_FLAG.buffer },
  })

  syncWorker.on('message', (msg) => {
    if (msg.type === 'ready') {
      logger.info('[PG SYNC] Worker thread ready')
    } else if (msg.type === 'result') {
      _syncResult = msg
      Atomics.store(_SYNC_FLAG, 0, 1)
      Atomics.notify(_SYNC_FLAG, 0)
    } else if (msg.type === 'error') {
      logger.error(`[PG SYNC] Worker error: ${msg.error}`)
    }
  })

  syncWorker.on('error', (err) => {
    logger.error(`[PG SYNC] Worker thread error: ${err.message}`)
  })

  syncWorker.on('exit', (code) => {
    logger.warn(`[PG SYNC] Worker exited (code ${code}) — will restart on next query`)
    syncWorker = null
  })

  syncWorker.unref()
  return syncWorker
}

function _syncPgQuery(text, params) {
  const w = _getSyncWorker()
  if (!w) {
    const msg = '[PG SYNC] Cannot execute sync query — DATABASE_URL not set on main thread'
    logger.error(msg)
    throw new Error(msg)
  }

  _queryIdCounter++
  const qid = _queryIdCounter

  // Reset flag BEFORE sending, not after (race-free ordering)
  _syncResult = null
  Atomics.store(_SYNC_FLAG, 0, 0)

  w.postMessage({ type: 'query', text, params: params || [], queryId: qid, originalSql: text })

  // Block main thread until worker responds or timeout
  const ret = Atomics.wait(_SYNC_FLAG, 0, 0, PG_SYNC_TIMEOUT_MS)

  if (ret === 'timed-out') {
    const msg = `[PG SYNC] Query timed out after ${PG_SYNC_TIMEOUT_MS}ms — SQL: ${(text || '').slice(0, 120)}`
    logger.error(msg)
    throw new Error(msg)
  }

  if (_syncResult?.error) {
    const err = new Error(`[PG SYNC] Query failed: ${_syncResult.error}`)
    err.code = _syncResult.code || 'PG_ERROR'
    err.sql = _syncResult.sql || text
    err.stack = _syncResult.stack || err.stack
    throw err
  }

  return { rows: _syncResult?.rows || [], rowCount: _syncResult?.rowCount || 0 }
}

const pgDb = {
  async exec(sql) {
    await query(sqliteToPg(sql))
  },

  async query(sql, params = []) {
    try {
      const result = await query(sql, params)
      const isMutation = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)/i.test(
        sql.trim()
      )
      if (isMutation) {
        return {
          rows: [],
          lastInsertRowid: result.rows?.[0]?.id || null,
          changes: result.rowCount || 0,
        }
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
    const pgSql = sqliteToPg(sql).replace(/\?(?=(?:[^']*'[^']*')*[^']*$)/g, () => `$${++qIdx}`)
    return {
      run: (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = _syncPgQuery(pgSql, params)
          return { lastInsertRowid: result.rows?.[0]?.id || null, changes: result.rowCount || 0 }
        } catch (e) {
          logger.error(`[PG PREPARE] run error: ${e.message} | SQL: ${pgSql.slice(0, 100)}`)
          return { changes: 0 }
        }
      },
      get: (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = _syncPgQuery(pgSql, params)
          return result.rows?.[0] || null
        } catch (e) {
          logger.error(`[PG PREPARE] get error: ${e.message} | SQL: ${pgSql.slice(0, 100)}`)
          return null
        }
      },
      all: (...args) => {
        const params = Array.isArray(args[0]) ? args[0] : args
        try {
          const result = _syncPgQuery(pgSql, params)
          return result.rows || []
        } catch (e) {
          logger.error(`[PG PREPARE] all error: ${e.message} | SQL: ${pgSql.slice(0, 100)}`)
          return []
        }
      },
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
        m.id,
        m.bsd_match_id || null,
        m.homeTeam,
        m.awayTeam,
        m.league,
        m.score?.home ?? 0,
        m.score?.away ?? 0,
        m.minute || '0',
        m.status || (m.isLive ? 'live' : 'scheduled'),
        m.prediction,
        m.confidence,
        fullData,
        m.timestamp || new Date().toISOString(),
        m.startTimestamp || null,
        stats.possession?.home || m.possession_home || 0,
        stats.possession?.away || m.possession_away || 0,
        stats.dangerousAttacks?.home || m.dangerous_attacks_home || 0,
        stats.dangerousAttacks?.away || m.dangerous_attacks_away || 0,
        stats.totalShots?.home || m.shots_on_target_home || 0,
        stats.totalShots?.away || m.shots_on_target_away || 0,
        stats.corners?.home || m.corners_home || 0,
        stats.corners?.away || m.corners_away || 0,
        m.source || 'flashscore',
        Date.now(),
        m.home_win_probability || 0,
        m.draw_probability || 0,
        m.away_win_probability || 0,
        m.expected_score || '1 - 1',
        m.chaos_score || 50,
        m.ou_25_prob || 0,
        m.btts_prob || 0,
        m.xgboost_confidence || 0,
        m.news_impact || 0,
        m.odds_home || null,
        m.odds_draw || null,
        m.odds_away || null,
        m.best_odds_home || null,
        m.best_odds_draw || null,
        m.best_odds_away || null,
        m.ev_home || null,
        m.ev_draw || null,
        m.ev_away || null,
        m.ev_best || 'NONE',
        m.odds_home_open || m.odds_home || null,
        m.odds_draw_open || m.odds_draw || null,
        m.odds_away_open || m.odds_away || null,
        m.true_prob_home || null,
        m.true_prob_draw || null,
        m.true_prob_away || null,
        m.true_prob_ou25 || null,
        m.true_prob_btts || null,
        m.clv_value || 0,
        m.kelly_stake || 0,
        m.weather_temp || 15,
        m.weather_desc || 'clear sky',
        m.weather_humidity || 50,
        m.home_form_pts || 0,
        m.away_form_pts || 0,
        m.insufficient_data || 0,
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
      const result = await query(
        `SELECT * FROM matches WHERE status IN (${placeholders}) ORDER BY timestamp ASC`,
        statuses
      )
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch (e) {
      logger.error(`[PG DB] getMatchesByStatuses failed: ${e.message}`)
      return []
    }
  },

  async resolveTeamName(name) {
    if (!name) return null
    const normalized = name
      .toLowerCase()
      .trim()
      .replace(/%20/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[.\-]/g, '')
    try {
      const row = await query(
        'SELECT name FROM team_registry WHERE normalized = $1 OR name LIKE $2 LIMIT 1',
        [normalized, `%${normalized}%`]
      )
      if (row.rows?.[0]) return row.rows[0].name
      const regId = Math.abs(
        name.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
      )
      try {
        await query(
          'INSERT INTO team_registry (id, name, normalized, last_seen) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO UPDATE SET last_seen = $4',
          [regId, name, normalized, Date.now()]
        )
      } catch (_) {}
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
        const parsed =
          (r.fullData ?? r.fulldata)
            ? typeof (r.fullData ?? r.fulldata) === 'string'
              ? JSON.parse(r.fullData ?? r.fulldata)
              : (r.fullData ?? r.fulldata)
            : {}
        return {
          ...r,
          ...parsed,
          id: r.id,
          homeTeam: r.homeTeam || parsed.homeTeam,
          awayTeam: r.awayTeam || parsed.awayTeam,
          league: r.league || parsed.league,
        }
      } catch (e) {
        return r
      }
    } catch (err) {
      return null
    }
  },

  async updatePredictions(matchId, data) {
    try {
      const result = await query('SELECT "fullData" FROM matches WHERE id = $1', [matchId])
      const row = result.rows?.[0]
      if (!row) return false

      let fullData =
        (row.fullData ?? row.fulldata)
          ? typeof (row.fullData ?? row.fulldata) === 'string'
            ? JSON.parse(row.fullData ?? row.fulldata)
            : (row.fullData ?? row.fulldata)
          : {}

      const enriched = data.enriched || (data.home_win_probability ? data : null)
      fullData = {
        ...fullData,
        ...data,
        enriched: enriched ? { ...(fullData.enriched || {}), ...enriched } : fullData.enriched,
        last_updated: Date.now(),
      }

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
      if (fullData.enriched?.enriched) delete fullData.enriched.enriched

      const verdict = data.verdict || data.enriched?.verdict || data.prediction || 'RISKY BET'
      const toNull = (v) =>
        v === null || v === undefined || (typeof v === 'number' && (isNaN(v) || !isFinite(v)))
          ? null
          : v
      const parseSafe = (v, fallback = 0) => {
        const n = parseFloat(v || fallback)
        return isNaN(n) ? null : n
      }

      const hProb = parseSafe(
        data.home_win_probability || enriched?.home_win_probability || fullData.home_win_probability
      )
      const dProb = parseSafe(
        data.draw_probability || enriched?.draw_probability || fullData.draw_probability
      )
      const aProb = parseSafe(
        data.away_win_probability || enriched?.away_win_probability || fullData.away_win_probability
      )
      const ou25 = parseSafe(data.ou_25_prob || enriched?.ou_25_prob || data.ou_2_5_prob)
      const bttsp = parseSafe(data.btts_prob || enriched?.btts_prob)
      const expScr =
        data.expected_score || enriched?.expected_score || fullData.expected_score || null
      const conf = parseSafe(data.confidence || enriched?.confidence || data.v22_success_rate)
      const xgbConf = parseSafe(data.xgboost_confidence || enriched?.xgboost_confidence)

      const sql = `
        UPDATE matches SET
          "fullData" = $1::jsonb, prediction = $2::text, last_updated = $3::bigint,
          home_win_probability = CASE WHEN $4::double precision IS DISTINCT FROM NULL AND $4::double precision > 0 THEN $4::double precision ELSE home_win_probability END,
          draw_probability = CASE WHEN $5::double precision IS DISTINCT FROM NULL AND $5::double precision > 0 THEN $5::double precision ELSE draw_probability END,
          away_win_probability = CASE WHEN $6::double precision IS DISTINCT FROM NULL AND $6::double precision > 0 THEN $6::double precision ELSE away_win_probability END,
          ou_25_prob = CASE WHEN $7::double precision IS DISTINCT FROM NULL AND $7::double precision > 0 THEN $7::double precision ELSE ou_25_prob END,
          btts_prob = CASE WHEN $8::double precision IS DISTINCT FROM NULL AND $8::double precision > 0 THEN $8::double precision ELSE btts_prob END,
          expected_score = CASE WHEN $9::text IS NOT NULL THEN $9::text ELSE expected_score END,
          confidence = CASE WHEN $10::double precision IS DISTINCT FROM NULL AND $10::double precision > 0 THEN $10::double precision ELSE confidence END,
          xgboost_confidence = CASE WHEN $11::double precision IS DISTINCT FROM NULL AND $11::double precision > 0 THEN $11::double precision ELSE xgboost_confidence END,
          ev_home = $12::double precision,
          ev_draw = $13::double precision,
          ev_away = $14::double precision,
          kelly_stake = $15::double precision,
          true_prob_home = $16::double precision,
          true_prob_draw = $17::double precision,
          true_prob_away = $18::double precision,
          weather_temp = $19::double precision,
          weather_humidity = $20::double precision,
          home_form_pts = $21::double precision,
          away_form_pts = $22::double precision,
          motivation_signature = $23::text,
          news_impact = $24::double precision,
          insufficient_data = 0
        WHERE id = $25::text
      `

      await query(sql, [
        JSON.stringify(fullData),
        verdict,
        Date.now(),
        toNull(hProb),
        toNull(dProb),
        toNull(aProb),
        toNull(ou25),
        toNull(bttsp),
        expScr,
        toNull(conf),
        toNull(xgbConf),
        toNull(data.ev_home),
        toNull(data.ev_draw),
        toNull(data.ev_away),
        toNull(data.kelly_stake),
        toNull(data.true_prob_home),
        toNull(data.true_prob_draw),
        toNull(data.true_prob_away),
        toNull(data.weather_temp),
        toNull(data.weather_humidity),
        toNull(data.home_form_pts),
        toNull(data.away_form_pts),
        data.motivation_signature || enriched?.motivation_signature || 'Logique Standard',
        toNull(data.news_impact),
        matchId,
      ])

      // Use explicit numeric id to avoid SERIAL sequence permission issues on Neon
      const idFromStr = (s) => {
        let h = 0
        for (let i = 0; i < s.length; i++) {
          h = (h << 5) - h + s.charCodeAt(i)
          h = h & h
        }
        return Math.abs(h)
      }
      const histBase = idFromStr(matchId)
      const histSql = `
        INSERT INTO prediction_history (id, match_id, league, prediction_type, prediction_val, probability, status, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT(match_id, prediction_type) DO UPDATE SET
          probability = EXCLUDED.probability, prediction_val = EXCLUDED.prediction_val
      `
      const safeDiv = (v) => (v != null && !isNaN(v) ? v / 100 : 0)
      try {
        await query(histSql, [
          histBase,
          matchId,
          fullData.league,
          'Home',
          'Win',
          safeDiv(hProb),
          'pending',
        ])
      } catch (_) {}
      try {
        await query(histSql, [
          histBase + 1,
          matchId,
          fullData.league,
          'Away',
          'Win',
          safeDiv(aProb),
          'pending',
        ])
      } catch (_) {}
      try {
        await query(histSql, [
          histBase + 2,
          matchId,
          fullData.league,
          'Draw',
          'Draw',
          safeDiv(dProb),
          'pending',
        ])
      } catch (_) {}

      logger.info(
        `[PG DB] AI Enrichment persisted for ${matchId} — Home:${hProb != null ? hProb.toFixed(1) : 'N/A'}% Draw:${dProb != null ? dProb.toFixed(1) : 'N/A'}% Away:${aProb != null ? aProb.toFixed(1) : 'N/A'}%`
      )
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
    } catch {
      return null
    }
  },

  getLeagueAverages: async () => ({
    avgTotalGoals: 2.7,
    avgHomeGoals: 1.5,
    avgAwayGoals: 1.2,
    matchCount: 0,
  }),

  async getAllLeaguesConfig() {
    try {
      const result = await query('SELECT * FROM leagues_config ORDER BY tier ASC, name ASC')
      return result.rows || []
    } catch {
      return []
    }
  },

  insertPlayerStat: async () => true,
  getPlayerStatsByTeam: async () => [],
  insertVisionLog: async () => true,

  async getHighImpactScheduledMatches() {
    try {
      const result = await query(
        `SELECT * FROM matches WHERE status = 'scheduled' AND "fullData" IS NOT NULL ORDER BY timestamp ASC LIMIT 20`
      )
      return result.rows.map((r) => {
        try {
          const parsed = JSON.parse((r.fullData ?? r.fulldata) || '{}')
          return { ...r, ...parsed }
        } catch {
          return r
        }
      })
    } catch {
      return []
    }
  },

  async getNewsPrecisionHistory() {
    try {
      const result = await query(
        `SELECT "homeTeam", "awayTeam", status, "scoreHome", "scoreAway", "fullData" FROM matches WHERE status IN ('FT', 'finished', 'Finished') ORDER BY timestamp DESC LIMIT 30`
      )
      let total = 0,
        hits = 0
      const matches = []
      for (const r of result.rows) {
        const data = JSON.parse((r.fullData ?? r.fulldata) || '{}')
        const pronos = data.enriched?.main_predictions
          ? data.enriched.main_predictions
          : data.predictions || []
        if (pronos.length === 0) continue
        total++
        const actual =
          (r.scoreHome ?? r.scorehome) > (r.scoreAway ?? r.scoreaway)
            ? 'H'
            : (r.scoreHome ?? r.scorehome) < (r.scoreAway ?? r.scoreaway)
              ? 'A'
              : 'D'
        let success = false
        pronos.forEach((p) => {
          const val = (p.val || '').toLowerCase()
          if ((val.includes('home') || val.includes('🏠') || val.includes('1')) && actual === 'H')
            success = true
          else if (
            (val.includes('away') || val.includes('✈️') || val.includes('2')) &&
            actual === 'A'
          )
            success = true
          else if ((val.includes('draw') || val.includes('x')) && actual === 'D') success = true
        })
        if (success) hits++
        matches.push({
          id: `${r.homeTeam}_${r.awayTeam}_${Date.now()}`,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          impact: 'High',
          success,
        })
      }
      return {
        total,
        accuracy: total > 0 ? Math.round((hits / total) * 100) : 0,
        matches: matches.slice(0, 10),
      }
    } catch {
      return { total: 0, accuracy: 0, matches: [] }
    }
  },

  seedLeagues: async () => true,
  getTeamMatchHistory: async () => [],

  async getInsufficientDataMatches() {
    try {
      const result = await query(
        `SELECT id, "homeTeam", "awayTeam", league, tournament_name, "fullData"
         FROM matches WHERE insufficient_data = 1
         AND status IN ('scheduled', 'upcoming', 'NOT_STARTED', 'NS')
         AND "homeTeam" IS NOT NULL AND "awayTeam" IS NOT NULL
         ORDER BY timestamp ASC`
      )
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch (e) {
      logger.error(`[PG DB] getInsufficientDataMatches failed: ${e.message}`)
      return []
    }
  },

  async getMatchesStartingSoon(hours = 4) {
    try {
      const now = Math.floor(Date.now() / 1000)
      const future = now + hours * 3600
      const result = await query(
        `SELECT id, "homeTeam", "awayTeam", league, tournament_name, "startTimestamp", timestamp, "fullData"
         FROM matches
         WHERE status IN ('scheduled', 'upcoming', 'NOT_STARTED', 'NS')
         AND ("startTimestamp" IS NOT NULL OR timestamp IS NOT NULL)
         AND "homeTeam" IS NOT NULL AND "awayTeam" IS NOT NULL
         AND (
             ("startTimestamp"::bigint > $1 AND "startTimestamp"::bigint <= $2)
             OR
             (timestamp >= $3 AND timestamp <= $4)
         )
         ORDER BY "startTimestamp" ASC`,
        [
          now - 3600,
          future,
          new Date(now * 1000).toISOString(),
          new Date(future * 1000).toISOString(),
        ]
      )
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch (e) {
      logger.error(`[PG DB] getMatchesStartingSoon failed: ${e.message}`)
      return []
    }
  },

  async getTeamAvgXg(teamName) {
    try {
      const name = teamName?.toLowerCase()?.trim()
      if (!name) return null
      const result = await query(
        `SELECT AVG(home_xg) as avg_h, AVG(away_xg) as avg_a
         FROM matches
         WHERE (LOWER("homeTeam") = $1 OR LOWER("awayTeam") = $2)
           AND home_xg IS NOT NULL AND away_xg IS NOT NULL`,
        [name, name]
      )
      const row = result.rows?.[0]
      if (!row) return null
      return {
        homeAvg: row.avg_h,
        awayAvg: row.avg_a,
        overallAvg: ((row.avg_h || 0) + (row.avg_a || 0)) / 2,
      }
    } catch (e) {
      logger.error(`[PG DB] getTeamAvgXg failed: ${e.message}`)
      return null
    }
  },

  async getRecentArchivedMatches(limit = 50) {
    try {
      const result = await query(
        `SELECT * FROM historical_matches WHERE "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL ORDER BY archived_at DESC LIMIT $1`,
        [limit]
      )
      return result.rows.map((r) => {
        const fd = (() => {
          try {
            return JSON.parse((r.fullData ?? r.fulldata) || '{}')
          } catch {
            return {}
          }
        })()
        return {
          ...r,
          ...fd,
          id: r.id,
          homeTeam: r.homeTeam,
          awayTeam: r.awayTeam,
          scoreHome: r.scoreHome ?? r.scorehome,
          scoreAway: r.scoreAway ?? r.scoreaway,
          league: r.league,
          timestamp: r.timestamp,
        }
      })
    } catch (e) {
      logger.warn(`[PG DB] getRecentArchivedMatches error: ${e.message}`)
      return []
    }
  },

  async getGoalModelParameters(tournamentName) {
    try {
      const result = await query(
        'SELECT * FROM league_model_parameters WHERE tournament_name = $1',
        [tournamentName]
      )
      return result.rows || []
    } catch (e) {
      logger.error(`[PG DB] getGoalModelParameters error: ${e.message}`)
      return []
    }
  },

  async upsertGoalModelParameter(params) {
    try {
      const ts = params.updated_at || new Date().toISOString()
      await query(
        `INSERT INTO league_model_parameters (tournament_name, team_name, attack_rating, defense_rating, hfa, rho, mu, distribution_type, num_matches, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(tournament_name, team_name) DO UPDATE SET
           attack_rating = EXCLUDED.attack_rating,
           defense_rating = EXCLUDED.defense_rating,
           hfa = EXCLUDED.hfa,
           rho = EXCLUDED.rho,
           mu = EXCLUDED.mu,
           distribution_type = EXCLUDED.distribution_type,
           num_matches = EXCLUDED.num_matches,
           updated_at = EXCLUDED.updated_at`,
        [
          params.tournament_name,
          params.team_name || null,
          params.attack_rating || 0,
          params.defense_rating || 0,
          params.hfa || 0.25,
          params.rho || -0.12,
          params.mu || 0.13,
          params.distribution_type || 'poisson',
          params.num_matches || 0,
          ts,
        ]
      )
      return true
    } catch (e) {
      logger.error(`[PG DB] upsertGoalModelParameter error: ${e.message}`)
      return false
    }
  },

  async getTeamPromosportStats(teamName) {
    try {
      const archivePath = path.resolve(__dirname, '../data/historical_archive.sqlite')
      if (!fs.existsSync(archivePath)) return null
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

      return {
        homeGames: homeTotal,
        awayGames: awayTotal,
        homeWinRate: homeTotal > 0 ? (homeResults.wins || 0) / homeTotal : null,
        homeDrawRate: homeTotal > 0 ? (homeResults.draws || 0) / homeTotal : null,
        awayWinRate: awayTotal > 0 ? (awayResults.wins || 0) / awayTotal : null,
        awayDrawRate: awayTotal > 0 ? (awayResults.draws || 0) / awayTotal : null,
      }
    } catch (e) {
      logger.warn(`[PG DB] getTeamPromosportStats failed for ${teamName}: ${e.message}`)
      return null
    }
  },

  async archiveFinishedMatches() {
    try {
      const finished = await query(
        `SELECT * FROM matches WHERE status IN ('FT', 'finished', 'Finished', 'Ended')`
      )
      if (finished.rows.length === 0) return { success: true, archivedCount: 0 }

      let count = 0
      for (const r of finished.rows) {
        const sh = r.scoreHome ?? r.scorehome ?? 0,
          sa = r.scoreAway ?? r.scoreaway ?? 0
        await query(
          `INSERT INTO historical_matches (id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", league, "fullData", timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
          [
            r.id,
            r.homeTeam,
            r.awayTeam,
            sh,
            sa,
            r.league,
            (r.fullData ?? r.fulldata) || '{}',
            r.timestamp || new Date().toISOString(),
          ]
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
        snapshot.source || 'unknown',
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
        const goalNext5 =
          finalScoreHome + finalScoreAway > (log.score_home || 0) + (log.score_away || 0) ? 1 : 0
        await query(
          `UPDATE live_prediction_logs SET actual_goal_next5 = $1, actual_goal_next10 = $1, actual_goal_next15 = $1,
           actual_final_home = $2, actual_final_away = $3, outcome_checked = 1, checked_at = NOW() WHERE id = $4`,
          [goalNext5, finalScoreHome, finalScoreAway, log.id]
        )
      }
      if (logs.rows.length > 0)
        logger.info(
          `[PG DB] Updated ${logs.rows.length} live prediction outcomes for match ${matchId}`
        )
      return logs.rows.length
    } catch (e) {
      logger.error(`[PG DB] updateLivePredictionOutcomes failed: ${e.message}`)
      return 0
    }
  },

  async getLivePredictionsForTraining(limit = 5000) {
    try {
      const result = await query(
        `SELECT * FROM live_prediction_logs WHERE outcome_checked = 1 AND actual_goal_next5 IS NOT NULL ORDER BY created_at DESC LIMIT $1`,
        [limit]
      )
      return result.rows || []
    } catch {
      return []
    }
  },

  async getUncheckedLivePredictions() {
    try {
      const result = await query(
        `SELECT DISTINCT match_id FROM live_prediction_logs WHERE outcome_checked = 0`
      )
      return result.rows || []
    } catch {
      return []
    }
  },

  async insertPattern(match) {
    try {
      const scoreStr = `${match.scoreHome || 0}-${match.scoreAway || 0}`
      const result = match.status === 'finished' ? 'WIN' : 'UNKNOWN'
      await query(
        `INSERT INTO winning_patterns (match_id, league, "homeTeam", "awayTeam", prediction, result, score, "fullData") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          match.id,
          match.league,
          match.homeTeam,
          match.awayTeam,
          match.prediction || 'N/A',
          result,
          scoreStr,
          (match.fullData ?? match.fulldata) || JSON.stringify(match),
        ]
      )
      return true
    } catch (e) {
      logger.error(`[PG DB] insertPattern failed: ${e.message}`)
      return false
    }
  },

  async getAllPatterns(limit = 100) {
    try {
      const result = await query(
        `SELECT * FROM winning_patterns ORDER BY timestamp DESC LIMIT $1`,
        [limit]
      )
      return result.rows || []
    } catch {
      return []
    }
  },

  getUpcomingPredictions: async () => [],
  insertPrediction: async (p) => p.id,

  async getMatchesByStatus(status, limit = null) {
    try {
      const parsedStatus =
        status === 'live' ? 'live' : status === 'scheduled' ? 'scheduled' : status
      const sql = limit
        ? `SELECT * FROM matches WHERE status = $1 ORDER BY timestamp ASC LIMIT $2`
        : `SELECT * FROM matches WHERE status = $1 ORDER BY timestamp ASC`
      const params = limit ? [parsedStatus, limit] : [parsedStatus]
      const result = await query(sql, params)
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch (e) {
      logger.error(`[PG DB] getMatchesByStatus failed: ${e.message}`)
      return []
    }
  },

  async cleanupStaleMatches() {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const result = await query(
        `DELETE FROM matches WHERE timestamp < $1 AND status NOT IN ('live', '1H', '2H', 'HT')`,
        [oneDayAgo]
      )
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
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch {
      return []
    }
  },

  async getMatchesByDate(dateStr) {
    try {
      const result = await query(
        `SELECT * FROM matches WHERE timestamp LIKE $1 ORDER BY timestamp ASC`,
        [`${dateStr}%`]
      )
      return result.rows.map((r) => {
        try {
          const parsed =
            (r.fullData ?? r.fulldata)
              ? typeof (r.fullData ?? r.fulldata) === 'string'
                ? JSON.parse(r.fullData ?? r.fulldata)
                : (r.fullData ?? r.fulldata)
              : {}
          return {
            ...r,
            ...parsed,
            id: r.id,
            homeTeam: r.homeTeam || parsed.homeTeam,
            awayTeam: r.awayTeam || parsed.awayTeam,
            league: r.league || parsed.league,
          }
        } catch (e) {
          return r
        }
      })
    } catch {
      return []
    }
  },

  async cleanupPlaceholderTeams() {
    try {
      const result = await query(
        `DELETE FROM matches WHERE LOWER("homeTeam") = 'home' OR LOWER("awayTeam") = 'away'`
      )
      if (result.rowCount > 0) logger.info(`[PG DB] Cleaned ${result.rowCount} placeholder matches`)
      return result.rowCount || 0
    } catch (e) {
      logger.error(`[PG DB] Cleanup error: ${e.message}`)
      return 0
    }
  },
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
