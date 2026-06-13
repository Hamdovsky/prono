const axios = require('axios');
const logger = require('../core/logger');

class SofascoreXgService {
    constructor() {
        this.baseUrl = 'https://api.sofascore.com/api/v1';
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.sofascore.com/'
        };
    }

    /**
     * Fetches xG and stats for a specific match via Sofascore
     * @param {string} sofascoreId The ID of the match on Sofascore
     */
    async fetchMatchXg(sofascoreId) {
        if (!sofascoreId) return null;
        try {
            // Sofascore provides xG in the /event/{id}/statistics endpoint
            const { data } = await axios.get(`${this.baseUrl}/event/${sofascoreId}/statistics`, {
                headers: this.headers,
                timeout: 10000
            });

            if (!data || !data.statistics) return null;

            const stats = data.statistics;
            // Extract xG values from the stats blob
            // Common keys: 'expected_goals_home', 'xg_home', etc.
            const xgH = stats['expected_goals_home'] || stats['xg_home'] || null;
            const xgA = stats['expected_goals_away'] || stats['xg_away'] || null;

            if (xgH === null && xgA === null) return null;

            return {
                home_xg: xgH,
                away_xg: xgA,
                source: 'SOFASCORE'
            };
        } catch (err) {
            logger.warn(`[SOFASCORE] xG fetch failed for ${sofascoreId}: ${err.message}`);
            return null;
        }
    }
}

module.exports = new SofascoreXgService();
