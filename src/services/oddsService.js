/**
 * oddsService.js
 * ─────────────────────────────────────────────────────────────
 * Fetches real 1X2 market odds directly from Sofascore's API.
 * Caches results per match for 15 minutes to avoid rate limits.
 * ─────────────────────────────────────────────────────────────
 */

const { fetch } = require('undici');
const { getRandomUserAgent } = require('../../SofascoreScraping/src/apiClient');

const SOFA_API = 'https://www.sofascore.com/api/v1';
const SOFA_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.sofascore.com/',
    'Origin': 'https://www.sofascore.com',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
};

// ── 15-minute in-memory cache ──────────────────────────────────
const oddsCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function getCached(matchId) {
    const entry = oddsCache.get(matchId);
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
    oddsCache.delete(matchId);
    return null;
}

function setCache(matchId, data) {
    oddsCache.set(matchId, { data, ts: Date.now() });
}

// ── Core fetch ──────────────────────────────────────────────────
/**
 * getLiveOdds(matchId)
 * Returns: { home: 1.85, draw: 3.40, away: 4.20 } or null on failure.
 *
 * Sofascore odds endpoint: /event/{id}/odds/1/featured
 * The featured market is usually the main 1X2 market.
 */
async function getLiveOdds(matchId) {
    if (!matchId) return null;

    const cached = getCached(matchId);
    if (cached) return cached;

    try {
        const url = `${SOFA_API}/event/${matchId}/odds/1/all`;
        const res = await fetch(url, {
            headers: {
                ...SOFA_HEADERS,
                'User-Agent': getRandomUserAgent()
            },
            method: 'GET'
        });

        if (!res.ok) return null;
        const data = await res.json();
        const markets = data?.markets;
        if (!markets || !Array.isArray(markets)) {
            console.error(`[OddsService] No markets found for ${matchId}`);
            return null;
        }

        // Standard Market ID for 1X2 in Sofascore is 1
        const market1x2 = markets.find(m => m.marketId === 1) || 
                         markets.find(m => (m.marketName || '').toLowerCase().includes('result')) ||
                         markets[0];

        if (!market1x2?.choices) {
            console.error(`[OddsService] No choices found in market for ${matchId}`);
            return null;
        }

        const odds = { home: null, draw: null, away: null };

        const parseSofaOdds = (choice) => {
            if (!choice) return null;
            
            // Prefer decimalValue if provided
            if (choice.decimalValue) return parseFloat(choice.decimalValue);
            
            // Fractional conversion: (num/den) + 1
            const raw = choice.fractionalValue;
            if (typeof raw === 'string' && raw.includes('/')) {
                const [num, den] = raw.split('/');
                const val = (parseFloat(num) / parseFloat(den)) + 1;
                return parseFloat(val.toFixed(3));
            }
            return parseFloat(raw);
        };

        for (const choice of market1x2.choices) {
            const name = (choice.name || '').toLowerCase();
            const val = parseSofaOdds(choice);
            if (!val || val <= 1) continue;

            if (name === '1' || name === 'home' || choice.sourceId === '1') odds.home = val;
            else if (name === 'x' || name === 'draw' || choice.sourceId === '2') odds.draw = val;
            else if (name === '2' || name === 'away' || choice.sourceId === '3') odds.away = val;
        }

        if (!odds.home || !odds.away) {
            console.error(`[OddsService] Incomplete odds for ${matchId}:`, odds);
            return null;
        }

        setCache(matchId, odds);
        return odds;

    } catch (err) {
        console.error(`[OddsService] Error fetching ${matchId}: ${err.message}`);
        return null;
    }
}

module.exports = { getLiveOdds };
