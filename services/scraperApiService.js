const axios = require('axios');
const logger = require('../core/logger');
const { pooledConfig } = require('../core/networkConfig');

class ScraperApiService {
    constructor() {
        this.timeout = 10000;
    }

    /**
     * Fetch match data from external API and normalize for Titanium Engine
     * @param {string} url - Scraper API URL
     * @returns {Promise<Array>} Normalized matches
     */
    async fetchMatches(url) {
        if (!url) {
            logger.error('Scraper API URL is missing');
            return [];
        }

        try {
            logger.info(`📡 [API SOURCE] Fetching from: ${url}`);
            const response = await axios.get(url, { ...pooledConfig, timeout: this.timeout });

            if (!response.data || !Array.isArray(response.data)) {
                logger.warn('Scraper API returned invalid or empty data');
                return [];
            }

            return response.data.map(m => this.normalize(m));
        } catch (error) {
            logger.error(`❌ Scraper API Error: ${error.message}`);
            return [];
        }
    }

    /**
     * Map external API fields to Titanium internal schema
     */
    normalize(m) {
        return {
            id: m.id || m.matchId || `api_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            homeTeam: m.home_team || m.homeTeam || 'Unknown',
            awayTeam: m.away_team || m.awayTeam || 'Unknown',
            league: m.league_name || m.league || 'Unknown',
            score: {
                home: m.score_home ?? m.score?.home ?? 0,
                away: m.score_away ?? m.score?.away ?? 0
            },
            minute: m.minute || '0',
            status: m.status || 'live',
            stats: {
                pressure: {
                    home: m.pressure_home || m.stats?.pressure?.home || 0,
                    away: m.pressure_away || m.stats?.pressure?.away || 0
                },
                dangerousAttacks: {
                    home: m.da_home || m.stats?.dangerousAttacks?.home || 0,
                    away: m.da_away || m.stats?.dangerousAttacks?.away || 0
                },
                corners: {
                    home: m.corners_home || m.stats?.corners?.home || 0,
                    away: m.corners_away || m.stats?.corners?.away || 0
                },
                possession: {
                    home: m.poss_home || m.stats?.possession?.home || 50,
                    away: m.poss_away || m.stats?.possession?.away || 50
                }
            },
            source: 'api_external',
            last_updated: Date.now(),
            odds_home: m.odds_home || m.odds?.home || null,
            odds_draw: m.odds_draw || m.odds?.draw || null,
            odds_away: m.odds_away || m.odds?.away || null
        };
    }
}

module.exports = new ScraperApiService();
