/**
 * 🎫 TITANIUM AI - SMART COMBO ENGINE (V2.0)
 * -----------------------------------------
 * Generates optimal match combinations (tickets) using 
 * multi-variant probability synthesis and risk-adjusted ROI.
 */

const database = require('../core/database');
const bankrollService = require('./bankrollService');
const logger = require('../core/logger');

class SmartComboEngine {
    constructor() {
        this.strategies = [
            {
                name: '🛡️ TICKET SÛR (SAFE)',
                minMatches: 2,
                maxMatches: 3,
                minProb: 0.75,
                targetOdds: [1.80, 2.50]
            },
            {
                name: '🔥 TICKET VALEUR (VALUE)',
                minMatches: 3,
                maxMatches: 5,
                minProb: 0.65,
                targetOdds: [4.00, 8.00]
            },
            {
                name: '💣 TICKET EXPLOSIF (ACCA)',
                minMatches: 6,
                maxMatches: 10,
                minProb: 0.55,
                targetOdds: [10.00, 50.00]
            }
        ];
    }

    async generateDailyTickets() {
        logger.info('🎫 [SMART-COMBO] Generating strategic daily tickets...');
        
        try {
            // 1. Fetch upcoming high-confidence matches
            const now = Math.floor(Date.now() / 1000);
            const tomorrow = now + 86400;
            
            const matches = await database.prepare(`
                SELECT * FROM matches 
                WHERE startTimestamp > ? AND startTimestamp < ?
                AND status = 'scheduled'
                AND (confidence >= 70 OR xgboost_confidence >= 0.75)
                ORDER BY confidence DESC
                LIMIT 40
            `).all(now, tomorrow);

            if (matches.length < 2) {
                logger.warn('🎫 [SMART-COMBO] Not enough high-confidence matches found.');
                return [];
            }

            const tickets = [];

            for (const strategy of this.strategies) {
                const candidates = matches.filter(m => {
                    const maxProb = Math.max(m.home_win_probability || 0, m.away_win_probability || 0, m.draw_probability || 0) / 100;
                    return maxProb >= strategy.minProb;
                });

                if (candidates.length < strategy.minMatches) continue;

                // Pick the best N matches for this strategy
                const selection = candidates.slice(0, strategy.maxMatches);
                
                let combinedProb = 1.0;
                let combinedOdds = 1.0;
                const legs = [];

                for (const m of selection) {
                    const h = m.home_win_probability || 0;
                    const a = m.away_win_probability || 0;
                    const d = m.draw_probability || 0;
                    
                    let pick = '1';
                    let prob = h / 100;
                    let odds = parseFloat(m.odds_home || (1/prob));

                    if (a > h && a > d) {
                        pick = '2'; prob = a / 100; odds = parseFloat(m.odds_away || (1/prob));
                    } else if (d > h && d > a) {
                        pick = 'X'; prob = d / 100; odds = parseFloat(m.odds_draw || (1/prob));
                    }

                    combinedProb *= prob;
                    combinedOdds *= odds;
                    
                    legs.push({
                        id: m.id,
                        home: m.homeTeam,
                        away: m.awayTeam,
                        league: m.league,
                        pick,
                        odds: odds.toFixed(2),
                        prob: (prob * 100).toFixed(1) + '%'
                    });

                    if (legs.length >= strategy.minMatches && combinedOdds >= strategy.targetOdds[0]) {
                        if (combinedOdds > strategy.targetOdds[1] && legs.length > strategy.minMatches) {
                            // Stop if we hit the target odds
                            break;
                        }
                    }
                }

                if (legs.length >= strategy.minMatches) {
                    // Calculate suggested stake using Kelly on the combined ticket
                    const kelly = bankrollService.calculateOptimalBet(combinedProb, combinedOdds);
                    
                    tickets.push({
                        strategy: strategy.name,
                        totalOdds: combinedOdds.toFixed(2),
                        combinedProb: (combinedProb * 100).toFixed(2) + '%',
                        suggestedStake: kelly.recommendedPercentage + '%',
                        legs: legs
                    });
                }
            }

            return tickets;

        } catch (error) {
            logger.error(`🎫 [SMART-COMBO] Error: ${error.message}`);
            return [];
        }
    }
}

module.exports = new SmartComboEngine();
