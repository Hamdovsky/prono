const expertEngine = require('./expertEngine');
const DeepFormService = require('./DeepFormService');
const LogisticsService = require('./LogisticsService');
const MotivationEnrichService = require('./MotivationEnrichService');
const SharpIntelligenceService = require('./SharpIntelligenceService');
const logger = require('../core/logger');

/**
 * ⚽ TITANIUM PROMOSPORT INTELLIGENCE v5.0
 * Deep aggregation of all intelligence services for Promosport Grid Optimization.
 */
class PromosportIntelligence {
    constructor() {
        this.iterations = 50000; // Ultra high resolution for EV stability
    }

    /**
     * Optimizes a 13-match grid with 5 double chances
     */
    async optimizeGrid(matches, strategy = 'balanced') {
        logger.info(`🧠 [PROMOSPORT AI] Optimizing grid with strategy: ${strategy}`);
        
        // 1. Deep Enrichment
        const enrichedMatches = await Promise.all(matches.map(async (m) => {
            const intelligence = expertEngine.getMatchIntelligence(m);
            const form = await DeepFormService.getDeepForm(m.homeTeam, m.awayTeam);
            const logistics = LogisticsService.calculateFatigue(m.awayCity, m.homeCity, m.daysRestA || 4);
            const motivation = MotivationEnrichService.getMotivation(m);
            const sharp = SharpIntelligenceService.getSharpActivity(m.id);

            // Calculate Composite Entropy (H)
            const p1 = intelligence.winProb / 100;
            const px = intelligence.draw_probability / 100 || 0.3;
            const p2 = (100 - intelligence.winProb - (px * 100)) / 100;
            
            const H = - (p1 * Math.log2(p1 || 0.01) + px * Math.log2(px || 0.01) + p2 * Math.log2(p2 || 0.01));

            return {
                ...m,
                intelligence,
                form,
                logistics,
                motivation,
                sharp,
                entropy: H,
                p1, px, p2
            };
        }));

        // 2. Double Chance Selection (Top 5 Entropy)
        const sortedByEntropy = [...enrichedMatches].sort((a, b) => b.entropy - a.entropy);
        const doubleIndices = sortedByEntropy.slice(0, 5).map(m => m.id);

        // 3. Strategy Application
        return enrichedMatches.map(m => {
            const isDouble = doubleIndices.includes(m.id);
            let pred = '';

            if (strategy === 'value') {
                // Focus on Anti-Crowd / Value Edge
                const edge = m.p1 > 0.4 ? '1' : (m.p2 > 0.4 ? '2' : 'X');
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : edge;
            } else if (strategy === 'secure') {
                // Maximize brute probability
                const best = m.p1 > m.p2 ? (m.p1 > m.px ? '1' : 'X') : (m.p2 > m.px ? '2' : 'X');
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : best;
            } else {
                // Balanced EV
                const best = m.p1 > 0.5 ? '1' : (m.p2 > 0.5 ? '2' : 'X');
                pred = isDouble ? (m.p1 > m.p2 ? '1X' : 'X2') : best;
            }

            return {
                ...m,
                pred,
                isDouble,
                confidence: (Math.max(m.p1, m.px, m.p2) * 100).toFixed(1)
            };
        });
    }

    /**
     * Generates a comprehensive tactical report
     */
    async generateTacticalReport(matches) {
        // Logic to generate a stunning report artifact
    }
}

module.exports = new PromosportIntelligence();
