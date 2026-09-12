// createMatchesDao — extrait de core/database.js (split 2026-09-07, découpe scriptée, contenu verbatim).
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

function createMatchesDao(db) {
  return {
    insertMatch: async (m) => {
      try {
        // Skip matches with placeholder team names
        const home = (m.homeTeam || '').toString().toLowerCase()
        const away = (m.awayTeam || '').toString().toLowerCase()
        if (home === 'home' || away === 'away') {
          logger.warn(
            `[DB] Skipping match ${m.id} — placeholder team name (${m.homeTeam} vs ${m.awayTeam})`
          )
          return false
        }

        let timestamp = new Date().toISOString()
        if (m.startTimestamp) {
          try {
            const d = new Date(m.startTimestamp * 1000)
            if (!isNaN(d.getTime())) timestamp = d.toISOString()
          } catch (e) {
            logger.warn(`[DB] Invalid timestamp for ${m.id}: ${m.startTimestamp}`)
          }
        }

        // Audit P4 : politique marchés — masquage réversible du 1X2 pur
        const __policy = applyMarketPolicy(m.prediction, m)
        if (__policy.converted) {
          logger.info(
            `[MARKET_POLICY] ${m.id} ${__policy.originalPrediction} -> ${__policy.prediction} (DISABLE_PURE_1X2)`
          )
          m.originalPrediction = __policy.originalPrediction
          m.prediction = __policy.prediction
        }

        // Audit BT1 : dérivation + persistance du pick BTTS au temps T
        const __btts = deriveBttsPick(m)
        if (__btts.bttsPick) {
          m.btts_pick = __btts.bttsPick
          m.btts_pick_prob = __btts.bttsProb
        }

        // Audit Q1 : dérivation + persistance des picks Corners / HT au temps T
        // (stockés dans fullData via mergedData, comme btts_pick — pas de colonne)
        const __corner = deriveCornerPick({
          quant: m.fullData?.quant,
          expected_corners: m.expected_corners ?? m.fullData?.expected_corners,
        })
        if (__corner.cornerPick) {
          m.corner_pick = __corner.cornerPick
          m.corner_pick_prob = __corner.cornerProb
        }
        const __ht = deriveHTPick({
          quant: m.fullData?.quant,
          ht_goal_prob: m.ht_goal_prob ?? m.fullData?.ht_goal_prob,
          league: m.league ?? m.fullData?.league,
        })
        if (__ht.htPick) {
          m.ht_pick = __ht.htPick
          m.ht_pick_prob = __ht.htProb
        }

        // Audit étape 1 : politique ligues — désambiguïsation Top-5 par pays
        const __lg = applyLeaguePolicy(m)
        if (__lg.changed) {
          logger.info(
            `[LEAGUE_POLICY] ${m.id} '${__lg.from}' -> '${__lg.to}' (pays=${__lg.country})`
          )
        }

        const dataToSave = { ...m }
        delete dataToSave.fullData

        // Merge with existing fullData if match already exists
        let mergedData = dataToSave
        try {
          const existing = db.prepare('SELECT fullData FROM matches WHERE id = ?').get(m.id)
          if (existing && existing.fullData) {
            const existingParsed =
              typeof existing.fullData === 'string'
                ? JSON.parse(existing.fullData)
                : existing.fullData
            mergedData = { ...existingParsed, ...dataToSave }
          }
        } catch (_) {}

        const fullData = JSON.stringify(mergedData)
        const stats = m.stats || m.statistics || {}

        // Best odds = max des sources disponibles
        m.best_odds_home = Math.max(m.odds_home || 0, m.best_odds_home || 0) || m.odds_home || null
        m.best_odds_draw = Math.max(m.odds_draw || 0, m.best_odds_draw || 0) || m.odds_draw || null
        m.best_odds_away = Math.max(m.odds_away || 0, m.best_odds_away || 0) || m.odds_away || null

        const timestampMs = m.timestamp ? new Date(m.timestamp).getTime() : null
        const startTs =
          m.startTimestamp != null
            ? m.startTimestamp
            : timestampMs
              ? Math.floor(timestampMs / 1000)
              : null

        const sql = `
                  INSERT INTO matches (
                      id, match_key, bsd_match_id, homeTeam, awayTeam, league, scoreHome, scoreAway, 
                      minute, status, prediction, confidence, fullData, timestamp, startTimestamp,
                      possession_home, possession_away, dangerous_attacks_home, dangerous_attacks_away,
                      shots_on_target_home, shots_on_target_away, corners_home, corners_away,
                      source, last_updated, home_win_probability, draw_probability, away_win_probability,
                      expected_score, chaos_score, ou_25_prob, btts_prob, xgboost_confidence, news_impact,
                      odds_home, odds_draw, odds_away, best_odds_home, best_odds_draw, best_odds_away,
                      ev_home, ev_draw, ev_away, ev_best,
                      odds_home_open, odds_draw_open, odds_away_open,
                      true_prob_home, true_prob_draw, true_prob_away, true_prob_ou25, true_prob_btts,
                      clv_value, kelly_stake,
                      weather_temp, weather_desc, weather_humidity, home_form_pts, away_form_pts, insufficient_data,
                      odds_over25, odds_under25, odds_btts_yes, odds_btts_no
                  ) VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?
                  ) ON CONFLICT (id) DO UPDATE SET 
                      match_key = COALESCE(excluded.match_key, matches.match_key),
                      bsd_match_id = COALESCE(excluded.bsd_match_id, matches.bsd_match_id),
                      scoreHome = excluded.scoreHome, scoreAway = excluded.scoreAway,
                      minute = excluded.minute, status = excluded.status, 
                      last_updated = excluded.last_updated, fullData = excluded.fullData,
                      prediction = COALESCE(excluded.prediction, matches.prediction),
                      confidence = COALESCE(excluded.confidence, matches.confidence),
                      expected_score = CASE WHEN excluded.expected_score != '1 - 1' THEN excluded.expected_score ELSE matches.expected_score END,
                      home_win_probability = COALESCE(excluded.home_win_probability, matches.home_win_probability),
                      draw_probability = COALESCE(excluded.draw_probability, matches.draw_probability),
                      away_win_probability = COALESCE(excluded.away_win_probability, matches.away_win_probability),
                      ou_25_prob = COALESCE(excluded.ou_25_prob, matches.ou_25_prob),
                      btts_prob = COALESCE(excluded.btts_prob, matches.btts_prob),
                      ev_home = COALESCE(excluded.ev_home, matches.ev_home),
                      ev_draw = COALESCE(excluded.ev_draw, matches.ev_draw),
                      ev_away = COALESCE(excluded.ev_away, matches.ev_away),
                      kelly_stake = COALESCE(excluded.kelly_stake, matches.kelly_stake),
                      possession_home = excluded.possession_home, possession_away = excluded.possession_away,
                      dangerous_attacks_home = excluded.dangerous_attacks_home, dangerous_attacks_away = excluded.dangerous_attacks_away,
                      odds_home = COALESCE(excluded.odds_home, matches.odds_home),
                      odds_draw = COALESCE(excluded.odds_draw, matches.odds_draw),
                      odds_away = COALESCE(excluded.odds_away, matches.odds_away),
                      odds_over25 = COALESCE(excluded.odds_over25, matches.odds_over25),
                      odds_under25 = COALESCE(excluded.odds_under25, matches.odds_under25),
                      odds_btts_yes = COALESCE(excluded.odds_btts_yes, matches.odds_btts_yes),
                      odds_btts_no = COALESCE(excluded.odds_btts_no, matches.odds_btts_no),
                      best_odds_home = COALESCE(excluded.best_odds_home, matches.best_odds_home),
                      best_odds_draw = COALESCE(excluded.best_odds_draw, matches.best_odds_draw),
                      best_odds_away = COALESCE(excluded.best_odds_away, matches.best_odds_away),
                      weather_temp = COALESCE(excluded.weather_temp, matches.weather_temp),
                      weather_desc = COALESCE(excluded.weather_desc, matches.weather_desc),
                      weather_humidity = COALESCE(excluded.weather_humidity, matches.weather_humidity),
                      home_form_pts = COALESCE(excluded.home_form_pts, matches.home_form_pts),
                      away_form_pts = COALESCE(excluded.away_form_pts, matches.away_form_pts),
                      insufficient_data = excluded.insufficient_data,
                      timestamp = excluded.timestamp,
                      startTimestamp = excluded.startTimestamp;
              `

        const params = [
          m.id,
          m.match_key || null,
          m.bsd_match_id || null,
          m.homeTeam,
          m.awayTeam,
          m.league,
          m.score?.home ?? m.scoreHome ?? 0,
          m.score?.away ?? m.scoreAway ?? 0,
          m.minute || '0',
          m.status || (m.isLive ? 'live' : 'scheduled'),
          m.prediction,
          m.confidence,
          fullData,
          timestamp,
          startTs,
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
          m.expected_score || null,
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
          m.weather_temp ?? null,
          m.weather_desc ?? null,
          m.weather_humidity ?? null,
          m.home_form_pts || 0,
          m.away_form_pts || 0,
          m.insufficient_data || 0,
          m.odds_over25 || null,
          m.odds_under25 || null,
          m.odds_btts_yes || null,
          m.odds_btts_no || null,
        ]

        db.prepare(sql).run(params)
        return m.id
      } catch (err) {
        logger.error(`SQLite insertMatch error: ${err.message}`)
        throw err
      }
    },

    updateMatchResult: async (matchKey, patch) => {
      if (!matchKey) return 0
      try {
        // Audit étape 3 : horodatage du settle (epoch ms) au moment où le score final est posé
        const settledAt =
          patch.settled_at ??
          (patch.status === 'finished' || patch.scoreHome != null ? Date.now() : null)
        const r = db
          .prepare(
            'UPDATE matches SET "scoreHome"=?, "scoreAway"=?, status=?, last_updated=?, settled_at=? WHERE "match_key"=?'
          )
          .run(
            patch.scoreHome ?? 0,
            patch.scoreAway ?? 0,
            patch.status || 'finished',
            Date.now(),
            settledAt,
            matchKey
          )
        return r.changes || 0
      } catch (err) {
        logger.error(`SQLite updateMatchResult error: ${err.message}`)
        return 0
      }
    },

    getMatchesByStatuses: async (statuses = [], opts = {}) => {
      if (!Array.isArray(statuses) || statuses.length === 0) return []
      try {
        const placeholders = statuses.map(() => '?').join(',')
        const limit = parseInt(opts.limit, 10)
        const params = [...statuses]
        let extraClause = ''
        // Optional startAfter (epoch seconds): drop stale scheduled matches so the
        // LIMIT is never consumed by long-past rows that no longer count as upcoming.
        if (opts.startAfter) {
          extraClause += ' AND "startTimestamp" IS NOT NULL AND "startTimestamp" >= ?'
          params.push(parseFloat(opts.startAfter))
        }
        // Optional startBefore (epoch seconds): cap the future horizon.
        if (opts.startBefore) {
          extraClause += ' AND "startTimestamp" <= ?'
          params.push(parseFloat(opts.startBefore))
        }
        // orderBy 'start' : tri par coup d'envoi (les PROCHAINS matchs d'abord)
        // au lieu de la date d'insertion — sinon les vieilles lignes déjà jouées
        // saturent le LIMIT et masquent les matchs à venir réels.
        // 'start_desc' : les plus proches dans le passé d'abord (fallback "récents").
        const orderClause =
          opts.orderBy === 'start'
            ? 'ORDER BY "startTimestamp" ASC'
            : opts.orderBy === 'start_desc'
              ? 'ORDER BY "startTimestamp" DESC'
              : 'ORDER BY timestamp ASC'
        const res = db
          .prepare(
            `SELECT * FROM matches WHERE status IN (${placeholders})${extraClause} ${orderClause}${
              limit > 0 ? ` LIMIT ${Math.min(limit, 5000)}` : ''
            }`
          )
          .all(params)
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
              : {}
            return {
              ...r,
              ...parsed,
              id: r.id,
              homeTeam: r.homeTeam || parsed.homeTeam,
              awayTeam: r.awayTeam || parsed.awayTeam,
              league: r.league || parsed.league,
              insufficient_data: r.insufficient_data,
              // 💾 DB columns are authoritative — the fullData blob (often stale,
              // e.g. livescore null odds) must NOT override backfilled odds.
              // C10 : O/U + BTTS épinglés aussi (oubli historique -> les picks
              // Top-Picks calculaient leur EV sur les fallbacks 1.85 du moteur).
              odds_home: r.odds_home ?? parsed.odds_home,
              odds_draw: r.odds_draw ?? parsed.odds_draw,
              odds_away: r.odds_away ?? parsed.odds_away,
              odds_over25: r.odds_over25 ?? parsed.odds_over25,
              odds_under25: r.odds_under25 ?? parsed.odds_under25,
              odds_btts_yes: r.odds_btts_yes ?? parsed.odds_btts_yes,
              odds_btts_no: r.odds_btts_no ?? parsed.odds_btts_no,
              odds_source: r.odds_source ?? parsed.odds_source,
              best_odds_home: r.best_odds_home ?? parsed.best_odds_home,
              best_odds_draw: r.best_odds_draw ?? parsed.best_odds_draw,
              best_odds_away: r.best_odds_away ?? parsed.best_odds_away,
              odds_home_open: r.odds_home_open ?? parsed.odds_home_open,
              odds_draw_open: r.odds_draw_open ?? parsed.odds_draw_open,
              odds_away_open: r.odds_away_open ?? parsed.odds_away_open,
            }
          } catch (e) {
            return r
          }
        })
      } catch (e) {
        logger.error(`[DB] getMatchesByStatuses failed: ${e.message}`)
        return []
      }
    },

    getAllMatches: async () => {
      try {
        const res = db.prepare(`SELECT * FROM matches ORDER BY timestamp DESC`).all()
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
              : {}
            return {
              ...r,
              ...parsed,
              id: r.id,
              homeTeam: r.homeTeam || parsed.homeTeam,
              awayTeam: r.awayTeam || parsed.awayTeam,
              league: r.league || parsed.league,
              insufficient_data: r.insufficient_data,
              odds_home: r.odds_home ?? parsed.odds_home,
              odds_draw: r.odds_draw ?? parsed.odds_draw,
              odds_away: r.odds_away ?? parsed.odds_away,
              odds_source: r.odds_source ?? parsed.odds_source,
              best_odds_home: r.best_odds_home ?? parsed.best_odds_home,
              best_odds_draw: r.best_odds_draw ?? parsed.best_odds_draw,
              best_odds_away: r.best_odds_away ?? parsed.best_odds_away,
              odds_home_open: r.odds_home_open ?? parsed.odds_home_open,
              odds_draw_open: r.odds_draw_open ?? parsed.odds_draw_open,
              odds_away_open: r.odds_away_open ?? parsed.odds_away_open,
            }
          } catch (e) {
            return r
          }
        })
      } catch (e) {
        logger.error(`[DB] getAllMatches failed: ${e.message}`)
        return []
      }
    },

    /**
     * Finds or creates a team alias to handle name normalization across sources.
     * E.g., "ESPERANCE" -> "Esperance Tunis"
     */
    resolveTeamName: async (name) => {
      if (!name) return null
      const normalized = name
        .toLowerCase()
        .trim()
        .replace(/%20/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[.\-]/g, '')

      try {
        // 1. Check if we have an alias in the registry
        const row = db
          .prepare('SELECT name FROM team_registry WHERE normalized = ? OR name LIKE ? LIMIT 1')
          .get(normalized, `%${normalized}%`)

        if (row) return row.name

        // 2. If not found, add it as a new entry for future learning
        db.prepare(
          'INSERT OR IGNORE INTO team_registry (name, normalized, last_seen) VALUES (?, ?, ?)'
        ).run(name, normalized, Date.now())

        return name
      } catch (e) {
        return name
      }
    },

    getMatchById: async (id) => {
      try {
        const r = db.prepare('SELECT * FROM matches WHERE id = ?').get(id)
        if (!r) return null
        try {
          const parsed = r.fullData
            ? typeof r.fullData === 'string'
              ? JSON.parse(r.fullData)
              : r.fullData
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

    getMatchByTeams: async (homeTeam, awayTeam) => {
      try {
        const simplify = (s) =>
          s
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .toLowerCase()
            .trim()
        const stripNoise = (words) =>
          words.filter(
            (w) =>
              !/^(fc|ac|cf|sc|rs|rj|sp|mg|pr|ba|pe|go|mt|ms|pa|rn|ce|pi|ma|ap|ro|ac|to|se|al|pb|df|es|rj)$/i.test(
                w
              ) && w.length > 1
          )
        const hWords = stripNoise(simplify(homeTeam).split(/\s+/).filter(Boolean))
        const aWords = stripNoise(simplify(awayTeam).split(/\s+/).filter(Boolean))
        if (!hWords.length || !aWords.length) return null
        const rows = db
          .prepare(
            'SELECT * FROM matches WHERE odds_home IS NOT NULL AND odds_draw IS NOT NULL AND odds_away IS NOT NULL ORDER BY last_updated DESC'
          )
          .all()
        for (const r of rows) {
          const rhWords = stripNoise(
            simplify(r.homeTeam || '')
              .split(/\s+/)
              .filter(Boolean)
          )
          const raWords = stripNoise(
            simplify(r.awayTeam || '')
              .split(/\s+/)
              .filter(Boolean)
          )
          if (!rhWords.length || !raWords.length) continue
          const allMatch = (pWords, dWords) =>
            pWords.length > 0 &&
            pWords.every((pw) =>
              dWords.some(
                (dw) => dw.includes(pw) || (pw.length > 2 && dw.length >= 3 && pw.includes(dw))
              )
            )
          if (allMatch(hWords, rhWords) && allMatch(aWords, raWords)) return r
        }
        return null
      } catch (err) {
        if (logger) logger.warn('[BSD] getMatchByTeams error:', err?.message)
        return null
      }
    },

    persistOdds: (matchId, row = {}) => {
      try {
        db.prepare(
          `UPDATE matches SET
             odds_home = COALESCE(?, odds_home),
             odds_draw = COALESCE(?, odds_draw),
             odds_away = COALESCE(?, odds_away),
             odds_over25 = COALESCE(?, odds_over25),
             odds_under25 = COALESCE(?, odds_under25),
             odds_btts_yes = COALESCE(?, odds_btts_yes),
             odds_btts_no = COALESCE(?, odds_btts_no),
             odds_source = ?,
             odds_fetch_error = ?,
             last_updated = ?
           WHERE id = ?`
        ).run(
          row.odds_home ?? null,
          row.odds_draw ?? null,
          row.odds_away ?? null,
          row.odds_over25 ?? null,
          row.odds_under25 ?? null,
          row.odds_btts_yes ?? null,
          row.odds_btts_no ?? null,
          row.odds_source ?? null,
          row.odds_fetch_error ?? null,
          Date.now(),
          matchId
        )
        logger.debug(
          `✅ [DB] odds persisted for ${matchId} (source=${row.odds_source || 'none'}, error=${row.odds_fetch_error || 'none'})`
        )
        return true
      } catch (err) {
        logger.warn(`[DB] persistOdds failed for ${matchId}: ${err.message}`)
        return false
      }
    },

    // ─── MERGE GARDÉ fullData (anti-lost-update) ──────────────────────────
    // Les services de sync (bigballs/futpython/predixsport/footballData) ne doivent
    // JAMAIS perdre la prédiction. Ils n'ont le droit d'écraser QUE leur clé namespace.
    // La ré-injection des colonnes indexées (source de vérité) protège contre un
    // stale-read cross-process : même si le fullData lu est obsolète, le verdict
    // prédiction/confiance/probas est rétabli à l'écriture.
    mergeFullData: (matchId, key, value) => {
      try {
        const row = db
          .prepare(
            `SELECT fullData, prediction, confidence, home_win_probability, draw_probability,
                    away_win_probability, expected_score, result, settled_at
             FROM matches WHERE id = ?`
          )
          .get(matchId)
        if (!row) return false

        let fd = {}
        try {
          fd = typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData || {}
        } catch (_) {
          fd = {}
        }

        // Whitelist stricte : seule la clé namespace du service est écrasée.
        if (fd[key] && typeof fd[key] === 'object' && value && typeof value === 'object') {
          fd[key] = { ...fd[key], ...value }
        } else {
          fd[key] = value
        }

        // Ré-injection anti-écrasement : les colonnes indexées font foi.
        const authoritative = {
          prediction: row.prediction,
          confidence: row.confidence,
          home_win_probability: row.home_win_probability,
          draw_probability: row.draw_probability,
          away_win_probability: row.away_win_probability,
          expected_score: row.expected_score,
          result: row.result,
          settled_at: row.settled_at,
        }
        for (const [k, v] of Object.entries(authoritative)) {
          if (v !== null && v !== undefined) fd[k] = v
        }

        db.prepare('UPDATE matches SET fullData = ?, last_updated = ? WHERE id = ?').run(
          JSON.stringify(fd),
          Date.now(),
          matchId
        )
        return true
      } catch (_) {
        return false
      }
    },

    getLatestMatchTimestamp: async () => {
      const row = db.prepare('SELECT MAX(timestamp) as lastupdate FROM matches').get()
      return row?.lastupdate
    },

    getTeamMatchHistory: async (teamName, limit = 5) => {
      return []
    },
    getTeamAvgXg: async (teamName) => {
      try {
        const name = teamName?.toLowerCase()?.trim()
        if (!name) return null
        const row = db
          .prepare(
            `
                  SELECT AVG(home_xg) as avg_h, AVG(away_xg) as avg_a
                  FROM matches
                  WHERE (LOWER(homeTeam) = ? OR LOWER(awayTeam) = ?)
                    AND home_xg IS NOT NULL AND away_xg IS NOT NULL
              `
          )
          .get(name, name)
        if (!row) return null
        return {
          homeAvg: row.avg_h,
          awayAvg: row.avg_a,
          overallAvg: ((row.avg_h || 0) + (row.avg_a || 0)) / 2,
        }
      } catch (e) {
        return null
      }
    },

    // ── Contexte CAC (2026-09-12) : prochaine rencontre + heures de repos ──
    // Timestamps stockés en s OU ms (selon ingest) -> normalisation JS après
    // une fenêtre SQL large (avant - 1 an / après + 7 j) pour éviter tout
    // Comparateur SQL fragile.
    getUpcomingFixturesByTeam: async (teamName, fromTs, toTs) => {
      try {
        const name = teamName?.toLowerCase()?.trim()
        if (!name) return []
        const sec = (t) => (t > 1e11 ? t / 1000 : t)
        const from = sec(fromTs)
        const to = sec(toTs)
        const rows = db
          .prepare(
            `
                  SELECT id, league, tournament_name, homeTeam, awayTeam, startTimestamp
                  FROM matches
                  WHERE (LOWER(homeTeam) = ? OR LOWER(awayTeam) = ?)
                    AND startTimestamp > 0
                    AND LOWER(COALESCE(status, 'scheduled')) IN ('scheduled', 'p', 'notstarted', 'tim', 'upcoming')
                  ORDER BY startTimestamp ASC
                  LIMIT 50
              `
          )
          .all(name, name)
        return rows
          .map((r) => ({ ...r, ts: sec(r.startTimestamp) }))
          .filter((r) => r.ts >= from && r.ts <= to)
      } catch (e) {
        return []
      }
    },
    getHoursRest: async (teamName, matchTs) => {
      try {
        const name = teamName?.toLowerCase()?.trim()
        if (!name || !matchTs) return null
        const sec = (t) => (t > 1e11 ? t / 1000 : t)
        const target = sec(matchTs)
        const rows = db
          .prepare(
            `
                  SELECT startTimestamp AS ts FROM matches
                   WHERE (LOWER(homeTeam) = ? OR LOWER(awayTeam) = ?)
                     AND LOWER(COALESCE(status, '')) IN ('ft', 'finished', 'ended', 'settled', 'aet')
                  UNION ALL
                  SELECT CAST(strftime('%s', timestamp) AS INTEGER) AS ts FROM historical_matches
                   WHERE (LOWER(homeTeam) = ? OR LOWER(awayTeam) = ?)
              `
          )
          .all(name, name, name, name)
        let last = 0
        for (const r of rows) {
          const t = sec(r.ts)
          if (t > 0 && t < target && t > target - 365 * 86400 && t > last) last = t
        }
        if (!last) return null
        const hours = (target - last) / 3600
        return hours > 0 && hours < 24 * 60 ? Math.round(hours * 10) / 10 : null
      } catch (e) {
        return null
      }
    },
    archiveFinishedMatches: async () => {
      try {
        const finished = db
          .prepare("SELECT * FROM matches WHERE status IN ('FT', 'finished', 'Finished', 'Ended')")
          .all()
        if (finished.length === 0) return { success: true, archivedCount: 0 }

        const insert = db.prepare(`
                  INSERT INTO historical_matches (
                      id, homeTeam, awayTeam, scoreHome, scoreAway, league, fullData, timestamp,
                      prediction, confidence, home_win_probability, draw_probability, away_win_probability,
                      expected_score, result, settled_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (id) DO NOTHING
              `)

        const updateHist = db.prepare(`
                  UPDATE prediction_history 
                  SET status = 'finished', 
                      result = CASE 
                          WHEN prediction_type = 'Home' AND ? > ? THEN 'won'
                          WHEN prediction_type = 'Away' AND ? < ? THEN 'won'
                          WHEN prediction_type = 'Draw' AND ? = ? THEN 'won'
                          ELSE 'lost'
                      END
                  WHERE match_id = ? AND prediction_type IN ('Home', 'Away', 'Draw')
              `)

        const deleteStmt = db.prepare('DELETE FROM matches WHERE id = ?')

        let count = 0
        const transaction = db.transaction((rows) => {
          for (const r of rows) {
            const sh = r.scoreHome ?? 0
            const sa = r.scoreAway ?? 0

            // Anti-écrasement : la colonne prediction/confiance est la source de vérité.
            // Si le fullData a été écrasé (ex: backfill externe), on y ré-injecte le verdict
            // avant l'archivage pour ne RIEN perdre.
            let fd = {}
            try {
              fd = typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData || {}
            } catch (_) {
              fd = {}
            }
            if (r.prediction && !fd.prediction) fd.prediction = r.prediction
            if (r.confidence != null && fd.confidence == null) fd.confidence = r.confidence
            if (r.result && !fd.result) fd.result = r.result
            if (r.settled_at != null && fd.settled_at == null) fd.settled_at = r.settled_at

            insert.run(
              r.id,
              r.homeTeam,
              r.awayTeam,
              sh,
              sa,
              r.league,
              JSON.stringify(fd),
              r.timestamp || new Date().toISOString(),
              r.prediction ?? null,
              r.confidence ?? null,
              r.home_win_probability ?? null,
              r.draw_probability ?? null,
              r.away_win_probability ?? null,
              r.expected_score ?? null,
              r.result ?? null,
              r.settled_at ?? null
            )
            updateHist.run(sh, sa, sh, sa, sh, sa, r.id)
            deleteStmt.run(r.id)
            count++
          }
        })

        transaction(finished)
        logger.info(`📦 [DB] Archived ${count} matches to historical_matches.`)
        return { success: true, archivedCount: count }
      } catch (e) {
        logger.error(`❌ [DB] Archive failed: ${e.message}`)
        return { success: false, error: e.message }
      }
    },
    getRecentArchivedMatches: async (limit = 50) => {
      try {
        const rows = db
          .prepare(
            'SELECT * FROM historical_matches WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY archived_at DESC LIMIT ?'
          )
          .all(limit)
        return rows.map((r) => {
          const fd = (() => {
            try {
              return JSON.parse(r.fullData || '{}')
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
            scoreHome: r.scoreHome,
            scoreAway: r.scoreAway,
            league: r.league,
            timestamp: r.timestamp,
          }
        })
      } catch (e) {
        logger.warn(`[DB] getRecentArchivedMatches error: ${e.message}`)
        return []
      }
    },
    getMatchesByStatus: async (status, limit = null) => {
      const parsedStatus =
        status === 'live' ? 'live' : status === 'scheduled' ? 'scheduled' : status
      const sql = limit
        ? `SELECT * FROM matches WHERE status = ? ORDER BY timestamp ASC LIMIT ?`
        : `SELECT * FROM matches WHERE status = ? ORDER BY timestamp ASC`
      const params = limit ? [parsedStatus, limit] : [parsedStatus]
      const res = db.prepare(sql).all(...params)
      return res.map((r) => {
        try {
          const parsed = r.fullData
            ? typeof r.fullData === 'string'
              ? JSON.parse(r.fullData)
              : r.fullData
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
    },

    getInsufficientDataMatches: async () => {
      try {
        const res = db
          .prepare(
            `SELECT * FROM matches WHERE insufficient_data = 1
                   AND status IN ('scheduled', 'upcoming', 'NOT_STARTED', 'NS')
                   AND homeTeam IS NOT NULL AND awayTeam IS NOT NULL
                   ORDER BY timestamp ASC`
          )
          .all()
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
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
        logger.error(`[DB] getInsufficientDataMatches failed: ${e.message}`)
        return []
      }
    },

    getMatchesMissingMarkets: async () => {
      try {
        // Matches that already carry real 1X2 odds but still lack O/U 2.5 and/or
        // BTTS markets. These are the rows whose dashboard O/U + BTTS cells render
        // "--" — the enricher must backfill their markets.
        const res = db
          .prepare(
            `SELECT * FROM matches
                   WHERE status IN ('scheduled', 'upcoming', 'NOT_STARTED', 'NS')
                   AND homeTeam IS NOT NULL AND awayTeam IS NOT NULL
                   AND (
                       (odds_over25 IS NULL OR odds_over25 = 0 OR odds_under25 IS NULL OR odds_under25 = 0)
                       OR (odds_btts_yes IS NULL OR odds_btts_yes = 0 OR odds_btts_no IS NULL OR odds_btts_no = 0)
                   )
                   ORDER BY timestamp ASC`
          )
          .all()
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
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
        logger.error(`[DB] getMatchesMissingMarkets failed: ${e.message}`)
        return []
      }
    },

    getMatchesStartingSoon: async (hours = 4) => {
      try {
        const now = new Date()
        const future = new Date(now.getTime() + hours * 3600 * 1000)
        const nowIso = now.toISOString()
        const futureIso = future.toISOString()
        const res = db
          .prepare(
            `SELECT id, homeTeam, awayTeam, league, tournament_name, startTimestamp, timestamp
                   FROM matches
                   WHERE status IN ('scheduled', 'upcoming', 'NOT_STARTED', 'NS')
                   AND (startTimestamp IS NOT NULL OR timestamp IS NOT NULL)
                   AND homeTeam IS NOT NULL AND awayTeam IS NOT NULL
                   AND (
                       (startTimestamp > 0 AND startTimestamp <= ? AND startTimestamp > ?)
                       OR
                       (timestamp >= ? AND timestamp <= ?)
                   )
                   ORDER BY startTimestamp ASC`
          )
          .all(
            Math.floor(future.getTime() / 1000),
            Math.floor(now.getTime() / 1000) - 3600,
            nowIso,
            futureIso
          )
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
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
        logger.error(`[DB] getMatchesStartingSoon failed: ${e.message}`)
        return []
      }
    },

    cleanupStaleMatches: async (retentionDays) => {
      try {
        // Delete stale matches older than N days that are not LIVE, plus their
        // linked prediction_history rows (winning_patterns kept for learning).
        const parsed = parseInt(retentionDays ?? process.env.STALE_MATCH_RETENTION_DAYS ?? '7', 10)
        const days = Number.isFinite(parsed) && parsed >= 1 ? parsed : 7
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        const liveStatuses = ['live', '1H', '2H', 'HT', 'inprogress']
        const placeholder = liveStatuses.map(() => '?').join(', ')

        const stale = db
          .prepare(`SELECT id FROM matches WHERE timestamp < ? AND status NOT IN (${placeholder})`)
          .all(cutoff, ...liveStatuses)
        if (stale.length === 0) return 0

        const ids = stale.map((r) => r.id)
        const idPlaceholder = ids.map(() => '?').join(', ')
        const run = db.transaction(() => {
          const matchesRes = db
            .prepare(`DELETE FROM matches WHERE id IN (${idPlaceholder})`)
            .run(...ids)
          const histRes = db
            .prepare(`DELETE FROM prediction_history WHERE match_id IN (${idPlaceholder})`)
            .run(...ids)
          return { matches: matchesRes.changes, history: histRes.changes }
        })()

        logger.info(
          `🧹 [DB] Cleaned up ${run.matches} stale matches (older than ${days} days) and ${run.history} linked prediction_history rows.`
        )
        return run.matches
      } catch (e) {
        logger.error(`❌ [DB] Cleanup failed: ${e.message}`)
        return 0
      }
    },

    getMatchesByDate: async (dateStr) => {
      try {
        // dateStr format: 'YYYY-MM-DD'
        // We search in the timestamp column which contains ISO dates
        const res = db
          .prepare(`SELECT * FROM matches WHERE timestamp LIKE ? ORDER BY timestamp ASC`)
          .all(`${dateStr}%`)
        return res.map((r) => {
          try {
            const parsed = r.fullData
              ? typeof r.fullData === 'string'
                ? JSON.parse(r.fullData)
                : r.fullData
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
        logger.error(`[DB] getMatchesByDate failed: ${e.message}`)
        return []
      }
    },
    cleanupPlaceholderTeams: () => {
      try {
        const count = db
          .prepare("DELETE FROM matches WHERE LOWER(homeTeam) = 'home' OR LOWER(awayTeam) = 'away'")
          .run()
        if (count.changes > 0) {
          logger.info(`[DB] Cleaned up ${count.changes} matches with placeholder team names`)
        }
        return count.changes
      } catch (e) {
        logger.error(`[DB] Cleanup error: ${e.message}`)
        return 0
      }
    },
    // ─── GOALMODEL PARAMETERS ──────────────────────────────────
  }
}

module.exports = { createMatchesDao }
