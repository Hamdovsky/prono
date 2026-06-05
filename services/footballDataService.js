const axios = require('axios');
const database = require('../core/database');
const logger = require('../core/logger');
const enrichedPredictions = require('../core/enriched_predictions');
const { createQuotaManager } = require('./sourceQuotaManager');

class FootballDataService {
    constructor() {
        this.apiKey  = process.env.FOOTBALLDATA_KEY || '';
        this.host    = process.env.FOOTBALLDATA_HOST || 'footballdata.io';
        this.baseUrl = `https://${this.host}/api/v1`;
        this.quota = createQuotaManager('footballdata');
    }

    // ── INTERNAL FETCH ──────────────────────────────────────────────────────

    async _fetch(endpoint) {
        if (!this.apiKey) {
            logger.warn('[FOOTBALLDATA] FOOTBALLDATA_KEY is missing.');
            return [];
        }

        try {
            logger.info(`📡 [FOOTBALLDATA] GET ${endpoint}`);
            const { data } = await axios.get(`${this.baseUrl}${endpoint}`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Accept': 'application/json'
                },
                timeout: 15000
            });
            // Handle both { fixtures: [] } and { data: { fixtures: [] } }
            const root = data?.data || data;
            return root?.fixtures || root?.matches || [];
        } catch (e) {
            logger.error(`❌ [FOOTBALLDATA] Request failed (${endpoint}): ${e.message}`);
            return [];
        }
    }

    // ── PUBLIC API ──────────────────────────────────────────────────────────

    /**
     * Fetches today's fixtures from FootballData.io
     */
    async fetchTodayFixtures() {
        if (process.env.FOOTBALLDATA_ENABLED !== 'true') {
            logger.warn('⚠️ [FOOTBALLDATA] Service is disabled in .env');
            return [];
        }
        const fixtures = await this._fetch('/fixtures/today');
        logger.info(`✅ [FOOTBALLDATA] Today: ${fixtures.length} fixtures`);
        return fixtures;
    }

    /**
     * Fetches upcoming (tomorrow + next few days) fixtures
     */
    async fetchUpcomingFixtures() {
        if (process.env.FOOTBALLDATA_ENABLED !== 'true') {
            logger.warn('⚠️ [FOOTBALLDATA] Service is disabled in .env');
            return [];
        }
        const fixtures = await this._fetch('/fixtures/upcoming');
        logger.info(`✅ [FOOTBALLDATA] Upcoming: ${fixtures.length} fixtures`);
        return fixtures;
    }

    /**
     * Fetches fixtures for a specific date (YYYY-MM-DD)
     */
    async fetchFixturesByDate(dateStr) {
        if (process.env.FOOTBALLDATA_ENABLED !== 'true') return [];
        const fixtures = await this._fetch(`/matches/date/${dateStr}`);
        logger.info(`✅ [FOOTBALLDATA] ${dateStr}: ${fixtures.length} fixtures`);
        return fixtures;
    }

    // ── MAP FD fixture → DB schema ──────────────────────────────────────────

    _mapFixture(f) {
        const matchId = f.match_id || f.id || `fd_${Date.now()}_${Math.random()}`;
        const ts = f.date_unix || f.timestamp || Math.floor(Date.now() / 1000);
        let timestamp = new Date().toISOString();
        try {
            const d = new Date(ts * 1000);
            if (!isNaN(d.getTime())) timestamp = d.toISOString();
        } catch (_) {}

        const rawStatus = (f.status || '').toLowerCase();
        let status = 'scheduled';
        if (rawStatus === 'complete' || rawStatus === 'ft') status = 'finished';
        else if (rawStatus === 'live' || rawStatus === 'inprogress') status = 'inprogress';

        return {
            id: `fd_${matchId}`,
            homeTeam: f.home_team?.team_name || f.home_team?.name || 'Home',
            awayTeam: f.away_team?.team_name || f.away_team?.name || 'Away',
            league: f.league?.competition_name || f.league?.name || 'Unknown',
            category_name: f.league?.country || '',
            tournament_name: f.league?.competition_name || f.league?.name || '',
            tournament_id: f.league?.competition_id || null,
            season_id: f.season_id || null,
            home_team_id: f.home_team?.team_id || null,
            away_team_id: f.away_team?.team_id || null,
            startTimestamp: ts,
            timestamp,
            status,
            confidence: 50,
            prediction: null,
            verdict: 'PENDING',
            odds_home: f.odds?.home_win || null,
            odds_draw: f.odds?.draw     || null,
            odds_away: f.odds?.away_win || null,
            home_xg: f.xg?.home || 1.1,
            away_xg: f.xg?.away || 1.0,
            last_updated: Date.now(),
            insufficient_data: 0,
            source: 'footballdata',
            fullData: JSON.stringify({
                homeTeam: f.home_team?.team_name,
                awayTeam: f.away_team?.team_name,
                league: f.league?.competition_name,
                startTimestamp: ts,
                status
            })
        };
    }

    // ── PIPELINE ────────────────────────────────────────────────────────────

    /**
     * Full fallback pipeline: fetch today + upcoming, insert, enrich
     */
    async processFallbackFixtures() {
        try {
            const quotaStatus = this.quota.getQuotaStatus();
            if (!quotaStatus.isActive || quotaStatus.remaining <= 0) {
                logger.warn(`[FOOTBALLDATA] Daily quota exhausted (${quotaStatus.used}/${quotaStatus.limit}).`);
                return 0;
            }

            const todayFixtures    = await this.fetchTodayFixtures();
            const upcomingFixtures = await this.fetchUpcomingFixtures();

            // Deduplicate by match_id
            const seen = new Set();
            let allFixtures = [...todayFixtures, ...upcomingFixtures].filter(f => {
                const fid = String(f.match_id || f.id || '');
                if (seen.has(fid)) return false;
                seen.add(fid);
                return true;
            });

            allFixtures = allFixtures.filter(f => this.quota.canProcessMatch(f.match_id || f.id));
            allFixtures = allFixtures.slice(0, quotaStatus.remaining);

            if (allFixtures.length === 0) return 0;

            let count = 0;
            for (const f of allFixtures) {
                try {
                    const match = this._mapFixture(f);

                    // Normalize team names via registry
                    try {
                        match.homeTeam = await database.resolveTeamName(match.homeTeam);
                        match.awayTeam = await database.resolveTeamName(match.awayTeam);
                    } catch (_) {}

                    // Insert raw match
                    await database.insertMatch(match);
                    this.quota.registerMatch(f.match_id || f.id || match.id);

                    // Perform Quant Poisson prediction & Kelly financials
                    const enriched = await enrichedPredictions.fastEnrichMatch(match);
                    await database.updatePredictions(enriched.id, enriched);

                    count++;
                } catch (matchErr) {
                    logger.error(`❌ [FOOTBALLDATA] Error processing match ${f.match_id}: ${matchErr.message}`);
                }
            }

            logger.info(`✅ [FOOTBALLDATA] Fallback pipeline complete: ${count} matches processed.`);
            return count;
        } catch (e) {
            logger.error(`❌ [FOOTBALLDATA] Fallback pipeline failed: ${e.message}`);
            return 0;
        }
    }
}

module.exports = new FootballDataService();
