const axios = require('axios');
const database = require('../core/database');
const logger = require('../core/logger');

const PROVIDERS = {
    API_FOOTBALL: {
        name: 'api-football',
        host: 'api-football-v1.p.rapidapi.com',
        basePath: '/v3',
        requiresKey: true,
        keyEnv: 'RAPIDAPI_KEY',
        rateLimit: 100
    },
    FOOTBALL_DATA_ORG: {
        name: 'football-data',
        host: 'api.football-data.org',
        basePath: '/v4',
        requiresKey: true,
        keyEnv: 'FOOTBALLDATA_KEY',
        rateLimit: 10
    }
};

class HttpScraperService {
    constructor() {
        this.rapidApiKey = process.env.RAPIDAPI_KEY || '';
        this.footballDataKey = process.env.FOOTBALLDATA_KEY || '';
        this.enabled = process.env.HTTP_SCRAPER_ENABLED !== 'false';
    }

    isAvailable() {
        return this.enabled && (!!this.rapidApiKey || !!this.footballDataKey);
    }

    async fetchAllFixtures(dateStr) {
        if (!this.isAvailable()) return [];
        const today = dateStr || new Date().toISOString().split('T')[0];

        if (this.rapidApiKey) {
            try {
                const fixtures = await this._fetchApiFootball(today);
                if (fixtures.length > 0) return fixtures;
            } catch (e) {
                logger.warn(`[HTTP-SCRAPER] API-Football failed: ${e.message}`);
            }
        }

        if (this.footballDataKey) {
            try {
                const fixtures = await this._fetchFootballDataOrg(today);
                if (fixtures.length > 0) return fixtures;
            } catch (e) {
                logger.warn(`[HTTP-SCRAPER] Football-data.org failed: ${e.message}`);
            }
        }

        return [];
    }

    async _fetchApiFootball(dateStr) {
        const url = `https://${PROVIDERS.API_FOOTBALL.host}${PROVIDERS.API_FOOTBALL.basePath}/fixtures?date=${dateStr}`;
        logger.info(`[HTTP-SCRAPER] GET ${url}`);

        const { data } = await axios.get(url, {
            headers: {
                'x-rapidapi-key': this.rapidApiKey,
                'x-rapidapi-host': PROVIDERS.API_FOOTBALL.host
            },
            timeout: 15000
        });

        const fixtures = data?.response || [];
        if (fixtures.length === 0) return [];

        return fixtures.map(f => this._mapApiFootballFixture(f)).filter(Boolean);
    }

    _mapApiFootballFixture(f) {
        try {
            const fixture = f.fixture || {};
            const teams = f.teams || {};
            const league = f.league || {};
            const goals = f.goals || {};
            const score = fixture.score || {};

            const homeTeam = teams.home?.name || 'Home';
            const awayTeam = teams.away?.name || 'Away';
            const ts = fixture.timestamp || Math.floor(Date.now() / 1000);

            const statusMap = {
                'TBD': 'scheduled', 'NS': 'scheduled', '1H': 'live',
                '2H': 'live', 'HT': 'live', 'ET': 'live', 'P': 'live',
                'FT': 'finished', 'AET': 'finished', 'PEN': 'finished',
                'BT': 'finished', 'SUSP': 'postponed', 'INT': 'postponed',
                'CANC': 'canceled', 'ABD': 'canceled', 'AWD': 'finished',
                'WO': 'finished', 'LIVE': 'live'
            };
            const rawStatus = (fixture.status?.short || 'NS').toUpperCase();
            const status = statusMap[rawStatus] || 'scheduled';

            return {
                id: `af_${fixture.id}`,
                homeTeam,
                awayTeam,
                home: homeTeam,
                away: awayTeam,
                league: league.name || 'Unknown',
                category_name: league.country || '',
                tournament_name: league.name || '',
                tournament_id: league.id ? String(league.id) : null,
                season_id: league.season ? String(league.season) : null,
                category_id: null,
                home_team_id: teams.home?.id ? String(teams.home.id) : null,
                away_team_id: teams.away?.id ? String(teams.away.id) : null,
                home_team_logo: teams.home?.logo || null,
                away_team_logo: teams.away?.logo || null,
                league_logo: league.logo || null,
                country_iso: (league.country || '').slice(0, 2).toUpperCase(),
                startTimestamp: ts,
                timeOrStatus: status === 'scheduled' ? 'Scheduled' : (status === 'finished' ? 'FT' : 'LIVE'),
                status,
                score: {
                    home: goals.home ?? null,
                    away: goals.away ?? null,
                    halftime: score.halftime || {},
                    fulltime: score.fulltime || {}
                },
                odds_home: null,
                odds_draw: null,
                odds_away: null,
                source: 'api-football',
                last_updated: Date.now()
            };
        } catch (err) {
            logger.warn(`[HTTP-SCRAPER] Failed to map api-football fixture: ${err.message}`);
            return null;
        }
    }

    async _fetchFootballDataOrg(dateStr) {
        const url = `https://${PROVIDERS.FOOTBALL_DATA_ORG.host}${PROVIDERS.FOOTBALL_DATA_ORG.basePath}/matches?date=${dateStr}`;
        logger.info(`[HTTP-SCRAPER] GET ${url}`);

        const { data } = await axios.get(url, {
            headers: {
                'X-Auth-Token': this.footballDataKey
            },
            timeout: 15000
        });

        const matches = data?.matches || [];
        if (matches.length === 0) return [];

        return matches.map(m => this._mapFootballDataOrgMatch(m)).filter(Boolean);
    }

    _mapFootballDataOrgMatch(m) {
        try {
            const homeTeam = m.homeTeam?.name || 'Home';
            const awayTeam = m.awayTeam?.name || 'Away';
            const competition = m.competition || {};

            const ts = m.utcDate ? Math.floor(new Date(m.utcDate).getTime() / 1000) : Math.floor(Date.now() / 1000);

            const statusMap = {
                'SCHEDULED': 'scheduled', 'TIMED': 'scheduled',
                'IN_PLAY': 'live', 'PAUSED': 'live',
                'FINISHED': 'finished', 'AWARDED': 'finished',
                'SUSPENDED': 'postponed', 'POSTPONED': 'postponed',
                'CANCELLED': 'canceled'
            };
            const rawStatus = (m.status || 'SCHEDULED').toUpperCase();
            const status = statusMap[rawStatus] || 'scheduled';

            const scoreHome = m.score?.fullTime?.home ?? null;
            const scoreAway = m.score?.fullTime?.away ?? null;

            return {
                id: `fd_${m.id}`,
                homeTeam,
                awayTeam,
                home: homeTeam,
                away: awayTeam,
                league: competition.name || 'Unknown',
                category_name: competition.area?.name || competition.name || '',
                tournament_name: competition.name || '',
                tournament_id: competition.id ? String(competition.id) : null,
                season_id: m.season?.id ? String(m.season.id) : null,
                home_team_id: m.homeTeam?.id ? String(m.homeTeam.id) : null,
                away_team_id: m.awayTeam?.id ? String(m.awayTeam.id) : null,
                country_iso: (competition.area?.code || '').toUpperCase(),
                startTimestamp: ts,
                timeOrStatus: status === 'scheduled' ? 'Scheduled' : (status === 'finished' ? 'FT' : 'LIVE'),
                status,
                score: { home: scoreHome, away: scoreAway },
                odds_home: null,
                odds_draw: null,
                odds_away: null,
                source: 'football-data',
                last_updated: Date.now()
            };
        } catch (err) {
            logger.warn(`[HTTP-SCRAPER] Failed to map football-data match: ${err.message}`);
            return null;
        }
    }

    async processFallback(opts = {}) {
        if (!this.isAvailable()) return 0;

        const targetDate = typeof opts === 'string' ? opts : opts.date
        const fullScan = typeof opts === 'object' ? opts.fullScan : false

        const dates = []
        if (targetDate) {
            dates.push(targetDate)
        } else if (fullScan) {
            // Full scan (06h cron): yesterday to +2 days = 4 dates
            const now = new Date()
            for (let d = -1; d <= 2; d++) {
                const dt = new Date(now)
                dt.setDate(dt.getDate() + d)
                dates.push(dt.toISOString().split('T')[0])
            }
        } else {
            // Incremental (12h/18h cron): today only = 1 date
            dates.push(new Date().toISOString().split('T')[0])
        }

        let totalCount = 0
        for (const date of dates) {
            const fixtures = await this.fetchAllFixtures(date);
            if (fixtures.length === 0) continue;

            logger.info(`[HTTP-SCRAPER] ${date}: ${fixtures.length} fixtures found`);

            for (const match of fixtures) {
                try {
                    await database.insertMatch({
                        ...match,
                        confidence: 50,
                        prediction: null,
                        verdict: 'PENDING',
                        fullData: JSON.stringify(match),
                        insufficient_data: 0
                    });
                    totalCount++;
                } catch (dbErr) {
                    logger.warn(`[HTTP-SCRAPER] DB insert failed for ${match.id}: ${dbErr.message}`);
                }
            }
        }

        // Update scraper progress for status endpoint
        const { saveScraperProgress } = require('../core/utils')
        await saveScraperProgress({
            isRunning: false, total: 0, done: 0, percent: 100, remaining: 0
        })

        logger.info(`[HTTP-SCRAPER] Done — inserted ${totalCount} matches across ${dates.length} dates.`);
        return totalCount;
    }
}

module.exports = new HttpScraperService();
