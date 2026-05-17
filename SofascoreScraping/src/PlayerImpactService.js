const axios = require('axios');

class PlayerImpactService {
    constructor() {
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
    }

    /**
     * Calculates the impact of missing players for both teams.
     * Returns { homeCoeff, awayCoeff }
     */
    async calculateImpact(matchId) {
        let homeCoeff = 1.0;
        let awayCoeff = 1.0;

        try {
            const url = `https://www.sofascore.com/api/v1/event/${matchId}/lineups`;
            const response = await axios.get(url, { headers: { 'User-Agent': this.userAgent } });
            
            if (!response.data) return { homeCoeff, awayCoeff };

            const { home, away } = response.data;

            if (home && home.missingPlayers) {
                homeCoeff = this.evaluateMissingPlayers(home.missingPlayers, 'attack', home.substitutes);
            }

            if (away && away.missingPlayers) {
                awayCoeff = this.evaluateMissingPlayers(away.missingPlayers, 'attack', away.substitutes);
            }

            // Note: In our current AI Engine, homeCoeff adjusts Home xG (scared/attacking)
            return {
                home_attack_mod: this.evaluateMissingPlayers(home?.missingPlayers, 'attack', home?.substitutes),
                home_defense_mod: this.evaluateMissingPlayers(home?.missingPlayers, 'defense', home?.substitutes),
                away_attack_mod: this.evaluateMissingPlayers(away?.missingPlayers, 'attack', away?.substitutes),
                away_defense_mod: this.evaluateMissingPlayers(away?.missingPlayers, 'defense', away?.substitutes)
            };

        } catch (e) {
            return {
                home_attack_mod: 1.0, home_defense_mod: 1.0,
                away_attack_mod: 1.0, away_defense_mod: 1.0
            };
        }
    }

    /**
     * @param {Array} missing - List of missing players
     * @param {string} mode - 'attack' or 'defense'
     * @param {Array} substitutes - Bench players to check for "Substitute Effect"
     */
    evaluateMissingPlayers(missing, mode, substitutes = []) {
        if (!missing || missing.length === 0) return 1.0;

        let multiplier = 1.0;

        for (const m of missing) {
            const player = m.player || {};
            const pos = player.position;
            const marketValue = player.proposedMarketValueRaw ? player.proposedMarketValueRaw.value : 0;
            const popularity = player.userCount || 0;
            const name = player.name || 'Unknown';

            const isStar = marketValue > 5000000 || popularity > 4000;
            const isElite = marketValue > 25000000 || popularity > 15000;

            // ── [NEW] Substitute Effect (تأثير البديل) ──
            // If the best substitute at the same position has >70% of the missing player's value,
            // we reduce the impact of the absence.
            let subQualityBonus = 1.0;
            if (substitutes && substitutes.length > 0 && marketValue > 0) {
                const samePosSubs = substitutes.filter(s => s.player?.position === pos);
                const bestSub = samePosSubs.reduce((prev, current) => {
                    const prevVal = prev.player?.proposedMarketValueRaw?.value || 0;
                    const currVal = current.player?.proposedMarketValueRaw?.value || 0;
                    return (currVal > prevVal) ? current : prev;
                }, { player: { proposedMarketValueRaw: { value: 0 } } });

                const bestSubValue = bestSub.player?.proposedMarketValueRaw?.value || 0;
                if (bestSubValue >= marketValue * 0.7) {
                    subQualityBonus = 0.5; // Reduce the penalty by 50%
                   // console.log(`🔄 [SUB EFFECT] ${name} has a strong replacement (${bestSub.player.name}). Penalty reduced.`);
                }
            }

            if (mode === 'attack') {
                if (pos === 'F' || pos === 'M') {
                    let penalty = 1.0;
                    if (isElite) penalty = 0.92;      // User Request: -8% for Forward (Elite default)
                    else if (isStar) penalty = 0.95; 
                    else penalty = 0.98;

                    // Apply sub bonus: e.g. if penalty was 0.92 (-8%), and sub is good, 
                    // effective penalty becomes 1 - (0.08 * 0.5) = 0.96
                    multiplier *= (1 - (1 - penalty) * subQualityBonus);
                }
            } else if (mode === 'defense') {
                if (pos === 'G') {
                    // User Request: -12% for Goalkeeper (1.12 factor in defense volatility)
                    let penaltyFactor = 1.12; 
                    if (isStar) penaltyFactor += 0.03; 
                    
                    multiplier *= (1 + (penaltyFactor - 1) * subQualityBonus);
                }
                if (pos === 'D') {
                    let penaltyFactor = 1.01;
                    if (isElite) penaltyFactor = 1.07;
                    else if (isStar) penaltyFactor = 1.04;
                    
                    multiplier *= (1 + (penaltyFactor - 1) * subQualityBonus);
                }
            }
        }

        return parseFloat(multiplier.toFixed(2));
    }
}

module.exports = PlayerImpactService;
