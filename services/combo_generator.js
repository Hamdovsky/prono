// TN-INTEL Live Combo Generator
// Generates intelligent multi-match combos from Elite data
const configEngine = require('../core/configEngine');

class ComboStrategy {
    constructor(name, minMatches, maxMatches, minTotalOdds, maxTotalOdds, criteria) {
        this.name = name;
        this.minMatches = minMatches;
        this.maxMatches = maxMatches;
        this.minTotalOdds = minTotalOdds;
        this.maxTotalOdds = maxTotalOdds;
        this.criteria = criteria;
    }

    evaluate(matches) {
        const { probMult, confMult } = configEngine.getStrategyParams();
        // Adjust criteria based on global strategy multipliers
        return matches.filter(m => {
            const mCopy = { ...m };
            // Artificially inflate/deflate thresholds for evaluation
            mCopy.probThreshold = 0.70 * probMult;
            mCopy.confThreshold = 0.70 * confMult;
            return this.criteria(mCopy);
        });
    }
}

class ComboGenerator {
    constructor() {
        this.strategies = [
            // 1. 🛡️ Bankroll Builder (Safe)
            new ComboStrategy(
                "Bankroll Builder",
                2, 3,
                1.30, 3.00,
                (m) => {
                    const prob = Math.max(m.home_win_probability || 0, m.away_win_probability || 0, m.draw_probability || 0);
                    return prob >= (m.probThreshold || 0.70);
                }
            ),
            // 2. ⚖️ Elite Double (Balanced)
            new ComboStrategy(
                "Elite Double",
                2, 2,
                2.20, 6.00,
                (m) => {
                    const prob = Math.max(m.home_win_probability || 0, m.away_win_probability || 0, m.draw_probability || 0);
                    return prob >= (m.probThreshold || 0.65) && (m.xgboost_confidence >= (m.confThreshold || 0.70));
                }
            ),
            // 3. 🚀 Moonshot (High Yield)
            new ComboStrategy(
                "Moonshot",
                3, 5,
                5.00, 50.00,
                (m) => {
                    const prob = Math.max(m.home_win_probability || 0, m.away_win_probability || 0, m.draw_probability || 0);
                    return prob >= (m.probThreshold || 0.55);
                }
            ),
            // 4. 💎 Millionaire Selection (Ultra-High Confidence)
            new ComboStrategy(
                "Millionaire Selection",
                1, 2,
                1.40, 4.00,
                (m) => {
                    // Inclusion criteria: Surgical Strike OR Ultra Confidence OR VVIP
                    return (m.verdict && m.verdict.includes("SURGICAL")) || 
                           (m.xgboost_confidence >= 0.88) ||
                           (m.isVVIP === true);
                }
            )
        ];
    }

    _calculateFairOdds(winProb) {
        if (!winProb || winProb <= 0) return 2.0;
        return parseFloat((100 / winProb).toFixed(2));
    }

    _generateCombinations(matches, size) {
        if (size === 1) return matches.map(m => [m]);
        const combos = [];
        for (let i = 0; i < matches.length - size + 1; i++) {
            const head = matches.slice(i, i + 1);
            const tailCombinations = this._generateCombinations(matches.slice(i + 1), size - 1);
            tailCombinations.forEach(tail => {
                combos.push(head.concat(tail));
            });
        }
        return combos;
    }

    generate(upcomingMatches) {
        const results = [];
        const todayStr = new Date().toISOString().split('T')[0];
        const params = configEngine.getStrategyParams();

        if (!upcomingMatches || !Array.isArray(upcomingMatches) || upcomingMatches.length === 0) {
            return results;
        }

        this.strategies.forEach(strategy => {
            // Apply global odds cap if it's lower than strategy max
            const effectiveMaxOdds = Math.min(strategy.maxTotalOdds, params.oddsCap);
            
            const candidates = strategy.evaluate(upcomingMatches)
                .sort((a, b) => b.xgboost_confidence - a.xgboost_confidence)
                .slice(0, 12);

            for (let size = strategy.minMatches; size <= strategy.maxMatches; size++) {
                if (candidates.length < size) continue;

                const combos = this._generateCombinations(candidates, size);

                combos.forEach(combo => {
                    let totalOdds = 1.0;
                    const matchIds = new Set();
                    let valid = true;

                    const legs = combo.map(m => {
                        if (matchIds.has(m.id)) valid = false;
                        matchIds.add(m.id);

                        let pick = "1";
                        let prob = m.home_win_probability || 0;
                        if ((m.away_win_probability || 0) > prob) { pick = "2"; prob = m.away_win_probability; }
                        if ((m.draw_probability || 0) > prob && (m.draw_probability || 0) > 0.4) { pick = "X"; prob = m.draw_probability; }

                        const odds = m[`odds_${pick === '1' ? 'home' : (pick === '2' ? 'away' : 'draw')}`] || this._calculateFairOdds(prob);
                        totalOdds *= odds;

                        return {
                            id: m.id,
                            homeTeam: m.homeTeam,
                            awayTeam: m.awayTeam,
                            pick: pick,
                            odds: odds,
                            prob: prob,
                            league: m.league
                        };
                    });

                    if (!valid) return;

                    if (totalOdds >= strategy.minTotalOdds && totalOdds <= effectiveMaxOdds) {
                        results.push({
                            id: `combo_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            date: todayStr,
                            strategy: strategy.name,
                            globalStrategy: params.label,
                            type: strategy.name,
                            totalOdds: parseFloat(totalOdds.toFixed(2)),
                            roi: 0, 
                            status: 'PENDING',
                            legs: legs,
                            generatedAt: new Date().toISOString()
                        });
                    }
                });
            }
        });

        const finalSelection = [];
        this.strategies.forEach(s => {
            const filtered = results.filter(r => r.strategy === s.name)
                .sort((a, b) => b.totalOdds - a.totalOdds)
                .slice(0, 2);
            finalSelection.push(...filtered);
        });

        return finalSelection;
    }
}

module.exports = ComboGenerator;
