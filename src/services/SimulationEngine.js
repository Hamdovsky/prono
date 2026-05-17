/**
 * Project Oracle: Quantum Simulation Engine (V5 Elite)
 * --------------------------------------------
 * Runs 20,000 Monte Carlo simulations per match using multiple Poisson distributions.
 * Predicts: Exact Scores, Pressure Waves, Expected Corners, and Expected Cards.
 * Features: DMF Integration, Climate Smoothing, and Ref Severity Calibration.
 */

class SimulationEngine {
    /**
     * Run 20,000 simulations
     * @param {Object} probs { homeWin, draw, awayWin, ou25, home_target_weight, away_target_weight, weather, refData, teamStats }
     */
    simulateMatch(probs) {
        const ITERATIONS = 20000;
        
        // 1. DYNAMIC LAMBDA DERIVATION (Quantum Goals)
        // Base goals based on OU2.5 probability (Continuous mapping instead of buckets)
        let baseLambda = (probs.ou25 / 100) * 1.8 + 1.6; // e.g. 70% OU2.5 -> 2.86 lambda
        
        // Apply Climate Smoothing (EnvironmentalIntelligence V55)
        if (probs.weather && probs.weather.goalMod) {
            baseLambda *= (1 + (probs.weather.goalMod / 100));
        }

        // Derive shares from win probabilities
        const totalWinP = (probs.homeWin || 33) + (probs.awayWin || 33) + ((probs.draw || 34) * 0.5);
        let homeShare = ((probs.homeWin || 33) + ((probs.draw || 34) * 0.3)) / (totalWinP || 1);
        let awayShare = ((probs.awayWin || 33) + ((probs.draw || 34) * 0.3)) / (totalWinP || 1);

        // Apply Dynamic Motivation Factor (DMF)
        if ((probs.home_target_weight || 0) > 1.2) homeShare *= 1.15; // "Must Win" boost
        if ((probs.away_target_weight || 0) > 1.2) awayShare *= 1.15;

        let homeLambda = baseLambda * homeShare;
        let awayLambda = baseLambda * awayShare;

        // 1B. INJECT PENALTY FACTOR (If Referee is Penalty Happy)
        if (probs.refData && probs.refData.isPenaltyHappy) {
            const PENALTY_XG = 0.76;
            // Distribute penalty xG based on attacking dominance (share)
            const dominantShareTotal = homeShare + awayShare || 1;
            const homePenaltyShare = homeShare / dominantShareTotal;
            const awayPenaltyShare = awayShare / dominantShareTotal;
            
            homeLambda += (PENALTY_XG * homePenaltyShare);
            awayLambda += (PENALTY_XG * awayPenaltyShare);
        }

        // 2. CORNER & CARD LAMBDAS (Simulated V5)
        // Average corners in football ~9.5 to 11.0
        const cornerLambda = (probs.teamStats?.cornersAvg || 10.2) * (probs.ou25 > 60 ? 1.08 : 0.92);
        
        // Average cards in football ~3.5 to 5.5 (Factoring referee severity)
        const refSeverity = probs.refData?.severity || 50; 
        const cardLambda = (3.5 + (refSeverity / 100) * 2.2);

        // 3. RUN MONTE CARLO (20k Iterations)
        const scoreBoard = {};
        let totalCorners = 0;
        let totalCards = 0;
        
        for (let i = 0; i < ITERATIONS; i++) {
            const hGoals = this._poissonRandom(homeLambda);
            const aGoals = this._poissonRandom(awayLambda);
            const scoreKey = `${hGoals}-${aGoals}`;
            scoreBoard[scoreKey] = (scoreBoard[scoreKey] || 0) + 1;
            
            totalCorners += this._poissonRandom(cornerLambda);
            totalCards += this._poissonRandom(cardLambda);
        }

        // 4. FORMAT RESULTS
        const topScores = Object.entries(scoreBoard)
            .map(([score, count]) => ({
                score,
                prob: Math.round((count / ITERATIONS) * 100)
            }))
            .sort((a, b) => b.prob - a.prob)
            .slice(0, 8);

        const pressureWave = this._generatePressureWave(homeLambda, awayLambda);

        return {
            v: "V5-Elite",
            topScores,
            expectedTotal: (homeLambda + awayLambda).toFixed(2),
            homeExp: homeLambda.toFixed(2),
            awayExp: awayLambda.toFixed(2),
            expCorners: (totalCorners / ITERATIONS).toFixed(1),
            expCards: (totalCards / ITERATIONS).toFixed(1),
            pressureWave
        };
    }

    _poissonRandom(lambda) {
        let L = Math.exp(-lambda);
        let p = 1.0;
        let k = 0;
        do {
            k++;
            p *= Math.random();
        } while (p > L);
        return k - 1;
    }

    _generatePressureWave(hL, aL) {
        const wave = [];
        let currentHome = hL * 15;
        let currentAway = aL * 15;
        
        for (let min = 0; min <= 90; min++) {
            // Random Walk smoothing (momentum bursts)
            currentHome += (Math.random() * 8 - 4) + (hL * 0.2); 
            currentAway += (Math.random() * 8 - 4) + (aL * 0.2);
            
            // Gravity (pull towards base lambda slowly)
            currentHome += (hL * 15 - currentHome) * 0.1;
            currentAway += (aL * 15 - currentAway) * 0.1;

            // Constrain
            currentHome = Math.max(0, Math.min(100, currentHome));
            currentAway = Math.max(0, Math.min(100, currentAway));

            // Sudden drops simulating fouls/stoppages/reset of possession
            if (Math.random() > 0.95) currentHome *= 0.2;
            if (Math.random() > 0.95) currentAway *= 0.2;

            // Late game desperation
            const timeModifier = min > 75 ? 1.4 : (min > 40 && min < 45 ? 1.2 : 1.0);
            
            const finalHome = Math.round(currentHome * timeModifier);
            const finalAway = Math.round(currentAway * timeModifier);

            // Export Away as negative for the diverging UI
            wave.push({
                minute: min,
                homePressure: Math.min(100, finalHome),
                awayPressure: -Math.min(100, finalAway)
            });
        }
        return wave;
    }
}

export default new SimulationEngine();
