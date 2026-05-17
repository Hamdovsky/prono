/**
 * 📈 TITANIUM AI - CLV (Closing Line Value) SERVICE
 * -----------------------------------------------
 * This service monitors upcoming matches and captures the "Closing Odds" 
 * just before the kick-off. It then calculates the CLV to measure 
 * the platform's edge over market efficiency.
 */

const db = require('../core/database');
const { SofaAPI } = require('../SofascoreScraping/src/apiClient');
const logger = require('../core/logger');

class CLVService {
    constructor() {
        this.MONITOR_WINDOW_MINUTES = 30; // Check matches starting in the next 30 mins
        this.isRunning = false;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info('🚀 [CLV] Closing Line Value monitor started.');
        
        // Run every 10 minutes
        setInterval(() => this.captureClosingOdds(), 10 * 60 * 1000);
        
        // Run immediately on start
        this.captureClosingOdds();
    }

    async captureClosingOdds() {
        try {
            const now = Date.now();
            const futureThreshold = now + (this.MONITOR_WINDOW_MINUTES * 60 * 1000);
            
            // 1. Find scheduled matches starting soon that don't have CLV yet
            const upcomingMatches = await db.prepare(`
                SELECT id, homeTeam, awayTeam, odds_home, odds_home_open, startTimestamp
                FROM matches
                WHERE status = 'scheduled'
                AND startTimestamp > ? AND startTimestamp < ?
                AND clv_value IS NULL
            `).all(now / 1000, futureThreshold / 1000);

            if (upcomingMatches.length === 0) {
                return;
            }

            logger.info(`🔍 [CLV] Capturing closing odds for ${upcomingMatches.length} matches...`);

            for (const match of upcomingMatches) {
                try {
                    const oddsData = await SofaAPI.getOddsFeatured(match.id);
                    const featured = Array.isArray(oddsData?.featured) ? oddsData.featured : [];
                    if (featured.length === 0) continue;

                    // Extract 1N2 odds from the featured list
                    const market = featured.find(f => f.marketId === 1); // 1 = 1N2
                    if (!market || !market.choices) continue;

                    const homeChoice = market.choices.find(c => c.fractionalValue === '1' || c.name === '1');
                    const drawChoice = market.choices.find(c => c.fractionalValue === 'X' || c.name === 'X');
                    const awayChoice = market.choices.find(c => c.fractionalValue === '2' || c.name === '2');

                    if (!homeChoice || !drawChoice || !awayChoice) continue;

                    const closingH = parseFloat(homeChoice.fractionalValue ? this._fractionalToDecimal(homeChoice.fractionalValue) : homeChoice.value);
                    const closingD = parseFloat(drawChoice.fractionalValue ? this._fractionalToDecimal(drawChoice.fractionalValue) : drawChoice.value);
                    const closingA = parseFloat(awayChoice.fractionalValue ? this._fractionalToDecimal(awayChoice.fractionalValue) : awayChoice.value);

                    // 2. Calculate CLV (Beat the Line)
                    // Formula: CLV = (Opening / Closing) - 1
                    const openingH = parseFloat(match.odds_home_open || match.odds_home || closingH);
                    const clvValue = (openingH / closingH) - 1;

                    // 3. Persist to DB
                    db.prepare(`
                        UPDATE matches 
                        SET clv_value = ?, 
                            odds_home = ?, 
                            odds_draw = ?, 
                            odds_away = ?
                        WHERE id = ?
                    `).run(clvValue, closingH, closingD, closingA, match.id);

                    // Log to odds_history
                    db.prepare(`
                        INSERT INTO odds_history (match_id, odds_home, odds_draw, odds_away, type, timestamp)
                        VALUES (?, ?, ?, ?, 'CLOSING', ?)
                    `).run(match.id, closingH, closingD, closingA, Date.now());

                    logger.info(`✅ [CLV] Captured for ${match.homeTeam}: Open ${openingH.toFixed(2)} -> Close ${closingH.toFixed(2)} | CLV: ${(clvValue * 100).toFixed(2)}%`);

                    // Delay to avoid API rate limiting
                    await new Promise(r => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ [CLV] Error processing match ${match.id}: ${err.message}`);
                }
            }
        } catch (error) {
            logger.error(`❌ [CLV] Global error: ${error.message}`);
        }
    }

    _fractionalToDecimal(frac) {
        if (typeof frac !== 'string' || !frac.includes('/')) return parseFloat(frac);
        const [num, den] = frac.split('/').map(Number);
        return (num / den) + 1;
    }
}

module.exports = new CLVService();
