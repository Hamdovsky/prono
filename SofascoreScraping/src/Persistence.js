const Database = require('better-sqlite3');
const path = require('path');

class Persistence {
    constructor() {
        this.dbPath = path.resolve(__dirname, '../../data/tactical.db');
        this.db = null;
    }

    init() {
        if (this.db) return Promise.resolve();
        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
            console.log(`🗄️  [PERSISTENCE] Linked to Titanium DB via better-sqlite3: ${this.dbPath}`);
            return Promise.resolve();
        } catch (err) {
            console.error("❌ [PERSISTENCE] DB Init Error:", err.message);
            return Promise.reject(err);
        }
    }

    checkMatchExists(matchId) {
        const row = this.db.prepare('SELECT id FROM matches WHERE id = ?').get(matchId);
        return !!row;
    }

    getMatch(matchId) {
        const row = this.db.prepare('SELECT id, fullData, odds_home, odds_draw, odds_away FROM matches WHERE id = ?').get(matchId);
        if (!row) return null;
        try {
            const data = JSON.parse(row.fullData || '{}');
            return {
                id: row.id,
                prediction: data.prediction || null,
                confidence: data.confidence || data.v22_success_rate || 50,
                verdict: data.verdict || null,
                has_odds: !!(row.odds_home && row.odds_draw && row.odds_away),
                has_enrichment: !!(data.enriched || data.form_context || data.teamStats),
            };
        } catch (e) {
            return { id: row.id, prediction: null, confidence: 50, has_odds: false, has_enrichment: false };
        }
    }

    insertMatch(matchData) {
        const stmt = this.db.prepare(`
            INSERT INTO matches (
                id, homeTeam, awayTeam, status, league, 
                category_id, category_name, tournament_id, tournament_name,
                scoreHome, scoreAway, minute, fullData, last_updated, timestamp,
                startTimestamp,
                prediction, confidence,
                referee, home_xg, away_xg, player_ratings_home, player_ratings_away,
                odds_home, odds_draw, odds_away, ev_home, ev_best,
                home_team_id, away_team_id, country_iso, tournament_id_official,
                home_attack_impact, home_defense_impact, away_attack_impact, away_defense_impact,
                referee_id, referee_yellow_avg, referee_red_avg, referee_penalties_avg,
                odds_home_open, odds_draw_open, odds_away_open,
                news_sentiment, is_missing_gk, is_missing_scorer, is_missing_captain, is_missing_star,
                home_market_value, away_market_value, referee_home_win_rate, is_high_pressure,
                weather_temp, weather_desc
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                prediction = COALESCE(excluded.prediction, matches.prediction),
                confidence = COALESCE(excluded.confidence, matches.confidence),
                scoreHome = excluded.scoreHome,
                scoreAway = excluded.scoreAway,
                minute = excluded.minute,
                fullData = excluded.fullData,
                last_updated = excluded.last_updated,
                referee = COALESCE(excluded.referee, matches.referee),
                home_xg = COALESCE(excluded.home_xg, matches.home_xg),
                away_xg = COALESCE(excluded.away_xg, matches.away_xg),
                player_ratings_home = COALESCE(excluded.player_ratings_home, matches.player_ratings_home),
                player_ratings_away = COALESCE(excluded.player_ratings_away, matches.player_ratings_away),
                odds_home = COALESCE(excluded.odds_home, matches.odds_home),
                odds_draw = COALESCE(excluded.odds_draw, matches.odds_draw),
                odds_away = COALESCE(excluded.odds_away, matches.odds_away),
                ev_home = COALESCE(excluded.ev_home, matches.ev_home),
                ev_best = COALESCE(excluded.ev_best, matches.ev_best),
                home_attack_impact = COALESCE(excluded.home_attack_impact, matches.home_attack_impact),
                home_defense_impact = COALESCE(excluded.home_defense_impact, matches.home_defense_impact),
                away_attack_impact = COALESCE(excluded.away_attack_impact, matches.away_attack_impact),
                away_defense_impact = COALESCE(excluded.away_defense_impact, matches.away_defense_impact),
                referee_id = COALESCE(excluded.referee_id, matches.referee_id),
                referee_yellow_avg = COALESCE(excluded.referee_yellow_avg, matches.referee_yellow_avg),
                referee_red_avg = COALESCE(excluded.referee_red_avg, matches.referee_red_avg),
                referee_penalties_avg = COALESCE(excluded.referee_penalties_avg, matches.referee_penalties_avg),
                odds_home_open = COALESCE(matches.odds_home_open, excluded.odds_home_open),
                odds_draw_open = COALESCE(matches.odds_draw_open, excluded.odds_draw_open),
                odds_away_open = COALESCE(matches.odds_away_open, excluded.odds_away_open),
                news_sentiment = COALESCE(excluded.news_sentiment, matches.news_sentiment),
                is_missing_gk = COALESCE(excluded.is_missing_gk, matches.is_missing_gk),
                is_missing_scorer = COALESCE(excluded.is_missing_scorer, matches.is_missing_scorer),
                is_missing_captain = COALESCE(excluded.is_missing_captain, matches.is_missing_captain),
                is_missing_star = COALESCE(excluded.is_missing_star, matches.is_missing_star),
                home_market_value = COALESCE(excluded.home_market_value, matches.home_market_value),
                away_market_value = COALESCE(excluded.away_market_value, matches.away_market_value),
                referee_home_win_rate = COALESCE(excluded.referee_home_win_rate, matches.referee_home_win_rate),
                is_high_pressure = COALESCE(excluded.is_high_pressure, matches.is_high_pressure),
                weather_temp = COALESCE(excluded.weather_temp, matches.weather_temp),
                weather_desc = COALESCE(excluded.weather_desc, matches.weather_desc),
                startTimestamp = COALESCE(excluded.startTimestamp, matches.startTimestamp)
        `);

        let isoTimestamp = null;
        if (matchData.startTimestamp) {
            isoTimestamp = new Date(matchData.startTimestamp * 1000).toISOString();
        }

        // Logic for V46: Extract news intelligence features for XGBoost
        const intel = matchData.news_intelligence || {};
        const feats = intel.home?.intelligence?.features || {};

        stmt.run(
            matchData.id,
            matchData.homeTeam,
            matchData.awayTeam,
            matchData.status,
            matchData.tournament_name || matchData.league || 'Unknown',
            matchData.category_id || null,
            matchData.category_name || 'Uncategorized',
            matchData.tournament_id || null,
            matchData.tournament_name || 'Unknown',
            matchData.score?.home || 0,
            matchData.score?.away || 0,
            matchData.timeOrStatus || '',
            JSON.stringify(matchData),
            Date.now(),
            isoTimestamp,
            matchData.startTimestamp || null,
            matchData.prediction || null,
            matchData.confidence || null,
            matchData.referee || null,
            matchData.home_xg || null,
            matchData.away_xg || null,
            matchData.player_ratings_home ? JSON.stringify(matchData.player_ratings_home) : null,
            matchData.player_ratings_away ? JSON.stringify(matchData.player_ratings_away) : null,
            matchData.odds_home || null,
            matchData.odds_draw || null,
            matchData.odds_away || null,
            matchData.ev_home || null,
            matchData.ev_best || null,
            matchData.home_team_id || null,
            matchData.away_team_id || null,
            matchData.country_iso || null,
            matchData.tournament_id_official || null,
            matchData.home_attack_impact || 1.0,
            matchData.home_defense_impact || 1.0,
            matchData.away_attack_impact || 1.0,
            matchData.away_defense_impact || 1.0,
            matchData.referee_id || null,
            matchData.referee_yellow_avg || 0,
            matchData.referee_red_avg || 0,
            matchData.referee_penalties_avg || 0,
            matchData.odds_home || null,
            matchData.odds_draw || null,
            matchData.odds_away || null,
            intel.home?.sentiment?.score || 0,
            feats.is_missing_gk || 0,
            feats.is_missing_scorer || 0,
            feats.is_missing_captain || 0,
            feats.is_missing_star || 0,
            matchData.v47_strategic?.home_market_value || 0,
            matchData.v47_strategic?.away_market_value || 0,
            matchData.v47_strategic?.referee_home_win_rate || 0.45,
            matchData.v47_strategic?.is_high_pressure || 0,
            matchData.weather_temp || null,
            matchData.weather_desc || null
        );

        if (matchData.odds_home) {
            console.log(`💰 [PERSIST] ${matchData.homeTeam} vs ${matchData.awayTeam}: H=${matchData.odds_home} (DB INSERT)`);
        }
    }

    insertPlayerStat(player) {
        try {
            const stmt = this.db.prepare(`
                INSERT INTO player_stats (player_id, name, team_name, position, goals, shots_on_target_avg, yellow_cards, red_cards, rating_avg, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(player_id) DO UPDATE SET
                    goals = excluded.goals,
                    shots_on_target_avg = excluded.shots_on_target_avg,
                    yellow_cards = excluded.yellow_cards,
                    red_cards = excluded.red_cards,
                    rating_avg = excluded.rating_avg,
                    last_updated = excluded.last_updated
            `);
            stmt.run(
                player.player_id,
                player.name,
                player.team_name,
                player.position,
                player.goals,
                player.shots_on_target_avg,
                player.yellow_cards,
                player.red_cards,
                player.rating_avg,
                Date.now()
            );
        } catch (e) {
            console.error(`[PERSISTENCE] Error inserting player stat: ${e.message}`);
        }
    }

    async heartbeat(matchId) {
        this.db.prepare('UPDATE matches SET last_updated = ? WHERE id = ?').run(Date.now(), matchId);
    }

    getOpeningOdds(matchId) {
        const row = this.db.prepare('SELECT odds_home_open, odds_draw_open, odds_away_open FROM matches WHERE id = ?').get(matchId);
        return row || null;
    }
}

module.exports = new Persistence();
