const { getPool, query: pgQuery } = require('../core/pg_connector')
const { resolve4 } = require('dns/promises')
const logger = require('../core/logger')

const SYNC_INTERVAL = 5 * 60 * 1000

class SupabaseService {
  constructor() {
    this.enabled = process.env.SUPABASE_ENABLED !== 'false'
    this.connected = false
    this._syncTimer = null
    this._lastError = null

    // Validate required config
    const url = process.env.DATABASE_URL || process.env.SUPABASE_URL
    if (!url || url.startsWith('CHANGER_MOI')) {
      logger.warn('⚠️ [SUPABASE] No DATABASE_URL/SUPABASE_URL — service disabled')
      this.enabled = false
    }
  }

  isAvailable() {
    if (!this.enabled) return false
    if (this._lastError && !this.connected) return false
    return true
  }

  async connect() {
    if (!this.enabled) {
      this._lastError = 'not initialized'
      return false
    }
    try {
      const pool = getPool()
      if (!pool) {
        this._lastError = 'no pool (SQLite mode)'
        return false
      }
      const client = await pool.connect()
      try {
        await client.query('SELECT 1')
      } finally {
        client.release()
      }
      this.connected = true
      this._lastError = null
      logger.info('✅ [SUPABASE] Connected (shared pool)')
      return true
    } catch (e) {
      this.connected = false
      this._lastError = e.message
      if (e.message.includes('ENETUNREACH') || e.message.includes('getaddrinfo')) {
        const host = process.env.DATABASE_URL || process.env.SUPABASE_URL || ''
        const parsed = new URL(host)
        logger.warn(`⚠️ [SUPABASE] DNS failed for ${parsed.hostname} — trying IPv4 resolution...`)
        try {
          const addrs = await resolve4(parsed.hostname)
          if (addrs.length > 0) {
            const ipUrl = host.replace(parsed.hostname, addrs[0])
            const { Pool } = require('pg')
            const directPool = new Pool({
              connectionString: ipUrl,
              max: 1,
              connectionTimeoutMillis: 10000,
              ssl: host.includes('supabase.co') || host.includes('neon.tech') ? { rejectUnauthorized: false } : undefined
            })
            const client = await directPool.connect()
            try {
              await client.query('SELECT 1')
            } finally {
              client.release()
            }
            await directPool.end()
            this.connected = true
            this._lastError = null
            logger.info(`✅ [SUPABASE] Connected via IPv4: ${addrs[0]}`)
            return true
          }
        } catch (dnsErr) {
          logger.warn(`⚠️ [SUPABASE] IPv4 resolution failed: ${dnsErr.message}`)
        }
      }
      logger.warn(`⚠️ [SUPABASE] Connection failed: ${e.message}`)
      return false
    }
  }

  async query(text, params) {
    if (!this.isAvailable()) return null
    try {
      return await pgQuery(text, params)
    } catch (e) {
      logger.error(`❌ [SUPABASE] Query error: ${e.message}`)
      return null
    }
  }

  async initSchema() {
    const sql = `
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        "homeTeam" TEXT,
        "awayTeam" TEXT,
        league TEXT,
        "scoreHome" INTEGER DEFAULT 0,
        "scoreAway" INTEGER DEFAULT 0,
        minute TEXT,
        status TEXT,
        prediction TEXT,
        confidence REAL,
        "fullData" TEXT,
        timestamp TEXT,
        "startTimestamp" BIGINT,
        "possession_home" INTEGER,
        "possession_away" INTEGER,
        "dangerous_attacks_home" INTEGER,
        "dangerous_attacks_away" INTEGER,
        "shots_on_target_home" INTEGER,
        "shots_on_target_away" INTEGER,
        "corners_home" INTEGER,
        "corners_away" INTEGER,
        source TEXT,
        last_updated BIGINT,
        "home_win_probability" REAL,
        "draw_probability" REAL,
        "away_win_probability" REAL,
        expected_score TEXT,
        chaos_score INTEGER,
        ou_25_prob REAL,
        btts_prob REAL,
        xgboost_confidence REAL,
        news_impact REAL,
        odds_home REAL,
        odds_draw REAL,
        odds_away REAL,
        ev_home REAL,
        ev_best TEXT,
        weather_temp REAL,
        weather_desc TEXT,
        weather_humidity REAL,
        home_form_pts REAL,
        away_form_pts REAL,
        insufficient_data INTEGER DEFAULT 0,
        category_id TEXT,
        category_name TEXT,
        tournament_id TEXT,
        tournament_name TEXT,
        referee TEXT,
        home_xg REAL,
        away_xg REAL,
        player_ratings_home TEXT,
        player_ratings_away TEXT,
        home_team_id TEXT,
        away_team_id TEXT
      );

      CREATE TABLE IF NOT EXISTS prediction_history (
        id SERIAL PRIMARY KEY,
        match_id TEXT,
        league TEXT,
        prediction_type TEXT,
        prediction_val TEXT,
        probability REAL,
        status TEXT DEFAULT 'PENDING',
        result TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(match_id, prediction_type)
      );

      CREATE TABLE IF NOT EXISTS quant_performance (
        id SERIAL PRIMARY KEY,
        match_id TEXT,
        taken_odds REAL,
        closing_odds REAL,
        clv REAL,
        pnl REAL,
        stake REAL,
        ev_at_bet REAL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS winning_patterns (
        id SERIAL PRIMARY KEY,
        match_id TEXT,
        league TEXT,
        "homeTeam" TEXT,
        "awayTeam" TEXT,
        prediction TEXT,
        result TEXT,
        score TEXT,
        "fullData" TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
      CREATE INDEX IF NOT EXISTS idx_matches_timestamp ON matches(timestamp);
      CREATE INDEX IF NOT EXISTS idx_history_match_id ON prediction_history(match_id);
    `
    const result = await this.query(sql)
    if (result) logger.info('✅ [SUPABASE] Schema initialized (shared pool)')
    await this.query('ALTER TABLE matches ALTER COLUMN "startTimestamp" TYPE BIGINT').catch(() => {})
    await this.query('ALTER TABLE matches ALTER COLUMN last_updated TYPE BIGINT').catch(() => {})
    return true
  }

  async upsertMatch(match) {
    if (!this.isAvailable()) return false
    try {
      await this.query(`
        INSERT INTO matches (
          id, "homeTeam", "awayTeam", league, status, prediction, confidence,
          "fullData", timestamp, "startTimestamp", source, last_updated,
          "home_win_probability", "draw_probability", "away_win_probability",
          odds_home, odds_draw, odds_away, insufficient_data
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          prediction = EXCLUDED.prediction,
          confidence = EXCLUDED.confidence,
          "home_win_probability" = EXCLUDED."home_win_probability",
          "draw_probability" = EXCLUDED."draw_probability",
          "away_win_probability" = EXCLUDED."away_win_probability",
          odds_home = EXCLUDED.odds_home,
          odds_draw = EXCLUDED.odds_draw,
          odds_away = EXCLUDED.odds_away,
          last_updated = EXCLUDED.last_updated
      `, [
        match.id, match.homeTeam, match.awayTeam, match.league, match.status,
        match.prediction, match.confidence, match.fullData, match.timestamp,
        match.startTimestamp, match.source, Date.now(),
        match.home_win_probability, match.draw_probability, match.away_win_probability,
        match.odds_home, match.odds_draw, match.odds_away,
        match.insufficient_data ?? 1
      ])
      return true
    } catch (e) {
      logger.warn(`⚠️ [SUPABASE] upsertMatch error: ${e.message}`)
      return false
    }
  }

  async getAllMatchIds() {
    if (!this.isAvailable()) return []
    const result = await this.query('SELECT id FROM matches')
    return result?.rows?.map(r => r.id) || []
  }

  async getMatch(id) {
    if (!this.isAvailable()) return null
    const result = await this.query('SELECT * FROM matches WHERE id = $1', [id])
    return result?.rows?.[0] || null
  }

  async syncFromSQLite(database) {
    if (!this.isAvailable()) return 0
    try {
      const rows = await database.db.prepare(`
        SELECT id, "homeTeam", "awayTeam", league, status, prediction, confidence,
               "fullData", timestamp, "startTimestamp", source, last_updated,
               "home_win_probability", "draw_probability", "away_win_probability",
               odds_home, odds_draw, odds_away, insufficient_data
        FROM matches WHERE status = 'scheduled'
        ORDER BY last_updated DESC LIMIT 500
      `).all()

      let synced = 0
      for (const row of rows) {
        const ok = await this.upsertMatch(row)
        if (ok) synced++
      }
      logger.info(`✅ [SUPABASE] Synced ${synced}/${rows.length} matches from SQLite`)
      return synced
    } catch (e) {
      logger.warn(`⚠️ [SUPABASE] Sync error: ${e.message}`)
      return 0
    }
  }

  async restoreToSQLite(database) {
    if (!this.isAvailable()) return 0
    // Skip in PG mode — no local SQLite to restore to
    if (!database.db || !database.db.pragma) {
      return 0
    }
    try {
      const result = await this.query(`
        SELECT id, "homeTeam", "awayTeam", league, status, prediction, confidence,
               "fullData", timestamp, "startTimestamp", source, last_updated,
               "home_win_probability", "draw_probability", "away_win_probability",
               odds_home, odds_draw, odds_away, insufficient_data
        FROM matches
        WHERE status = 'scheduled'
        ORDER BY last_updated DESC LIMIT 500
      `)
      if (!result?.rows?.length) {
        logger.info('⏭️ [SUPABASE] No remote matches to restore')
        return 0
      }

      const upsert = database.db.prepare(`
        INSERT OR REPLACE INTO matches (
          id, "homeTeam", "awayTeam", league, status, prediction, confidence,
          "fullData", timestamp, "startTimestamp", source, last_updated,
          "home_win_probability", "draw_probability", "away_win_probability",
          odds_home, odds_draw, odds_away, insufficient_data
        ) VALUES (
          @id, @homeTeam, @awayTeam, @league, @status, @prediction, @confidence,
          @fullData, @timestamp, @startTimestamp, @source, @last_updated,
          @home_win_probability, @draw_probability, @away_win_probability,
          @odds_home, @odds_draw, @odds_away, @insufficient_data
        )
      `)

      const tx = database.db.transaction((rows) => {
        for (const row of rows) {
          upsert.run(row)
        }
      })
      tx(result.rows)
      logger.info(`✅ [SUPABASE] Restored ${result.rows.length} matches from cloud to SQLite`)
      return result.rows.length
    } catch (e) {
      logger.warn(`⚠️ [SUPABASE] Restore error: ${e.message}`)
      return 0
    }
  }

  startPeriodicSync(database) {
    if (!this.enabled || this._syncTimer) return

    const sync = async () => {
      if (!this.isAvailable()) return
      await this.syncFromSQLite(database)
    }

    sync()
    this._syncTimer = setInterval(sync, SYNC_INTERVAL)
    logger.info(`⏰ [SUPABASE] Periodic sync every ${SYNC_INTERVAL / 60000}min started`)
  }

  stopPeriodicSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer)
      this._syncTimer = null
    }
  }

  async cleanupPlaceholderTeams() {
    if (!this.isAvailable()) return 0
    try {
      const result = await this.query(`
        DELETE FROM matches
        WHERE LOWER("homeTeam") = 'home' OR LOWER("awayTeam") = 'away'
      `)
      const count = result?.rowCount || 0
      if (count > 0) logger.info(`☁️ [SUPABASE] Cleaned ${count} placeholder matches from cloud`)
      return count
    } catch (e) {
      logger.warn(`⚠️ [SUPABASE] Cloud cleanup error: ${e.message}`)
      return 0
    }
  }
}

module.exports = new SupabaseService()
