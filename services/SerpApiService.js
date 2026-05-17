/**
 * 🔍 TITANIUM AI - SERPAPI SEARCH CORE SERVICE
 * -------------------------------------------------------------
 * Fetches real-time web search results (team news, injuries, lineups)
 * using the provided SerpApi key with strict budget protection.
 */

const axios = require('axios');
const dotenv = require('dotenv');
const logger = require('../core/logger');

dotenv.config();

class SerpApiService {
    constructor() {
        this.apiKey = process.env.SERPAPI_API_KEY || '';
    }

    /**
     * Performs a Google Search query and returns clean, structured snippets.
     * Consumes exactly 1 SerpApi search.
     */
    async searchLatestNews(homeTeam, awayTeam) {
        if (!this.apiKey) {
            logger.warn('⚠️ [SERPAPI] Missing API Key in .env file.');
            return 'No real-time search context available (API key missing).';
        }

        const query = `"${homeTeam}" vs "${awayTeam}" team news injuries suspensions lineup`;
        logger.info(`🔍 [SERPAPI] Searching Google for: ${query}`);

        try {
            const response = await axios.get('https://serpapi.com/search', {
                params: {
                    engine: 'google',
                    q: query,
                    api_key: this.apiKey,
                    hl: 'fr', // Preferred language for soccer news
                    gl: 'fr',
                    num: 5 // Get top 5 results for efficiency
                },
                timeout: 8000
            });

            const results = response.data;
            let snippets = [];

            // 1. Extract from organic results
            if (results.organic_results && results.organic_results.length > 0) {
                results.organic_results.forEach((item, index) => {
                    if (item.snippet) {
                        snippets.push(`[${index + 1}] (${item.title}): "${item.snippet}"`);
                    }
                });
            }

            // 2. Extract from sports results/news if present
            if (results.sports_results && results.sports_results.game_spotlight) {
                snippets.push(`[Spotlight]: ${results.sports_results.game_spotlight}`);
            }

            if (snippets.length === 0) {
                return 'Aucune actualité de dernière minute trouvée sur Google Search.';
            }

            return snippets.join('\n\n');
        } catch (e) {
            logger.error(`❌ [SERPAPI] Google search query failed: ${e.message}`);
            return 'Erreur lors de la récupération des actualités en direct.';
        }
    }
}

module.exports = new SerpApiService();
