/**
 * Titanium Quant Service
 * Implémentation Node.js ultra-rapide des moteurs mathématiques institutionnels (EV+, Shin Margin Remover, Kelly).
 * S'exécute en < 1ms par match pour éviter de bloquer l'Event Loop lors de l'ingestion massive.
 */

const logger = require('../core/logger');

class QuantService {
    /**
     * Supprime la marge du bookmaker proportionnellement à la probabilité impliquée.
     */
    static removeMarginProportional(odds) {
        const impliedProbs = odds.map(o => o > 0 ? 1 / o : 0);
        const margin = impliedProbs.reduce((a, b) => a + b, 0);
        
        if (margin <= 1.0 || margin === 0) return impliedProbs;
        
        return impliedProbs.map(p => p / margin);
    }

    /**
     * Méthode Shin Approximation
     * Prend en compte le Favorite-Longshot bias.
     */
    static removeMarginShin(odds) {
        const impliedProbs = odds.map(o => o > 0 ? 1 / o : 0);
        const margin = impliedProbs.reduce((a, b) => a + b, 0) - 1.0;
        
        if (margin <= 0) return impliedProbs;

        let z = 0.0;
        let step = 0.001;
        let bestZ = 0;
        let minDiff = 1000;
        let trueProbs = [...impliedProbs];
        
        // Iterative Shin calculation
        for (let i = 1; i < 100; i++) {
            let currentZ = i * step;
            let sumP = 0;
            let tempProbs = [];
            
            for (let p of impliedProbs) {
                let term1 = Math.pow(currentZ, 2);
                let term2 = 4 * (1 - currentZ) * (Math.pow(p, 2) / (margin + 1));
                
                if (term1 + term2 >= 0) {
                    let calcP = (Math.sqrt(term1 + term2) - currentZ) / (2 * (1 - currentZ));
                    sumP += calcP;
                    tempProbs.push(calcP);
                } else {
                    sumP += p;
                    tempProbs.push(p);
                }
            }
            
            let diff = Math.abs(1.0 - sumP);
            if (diff < minDiff) {
                minDiff = diff;
                bestZ = currentZ;
                trueProbs = tempProbs;
            }
        }
        
        // Normalize
        const total = trueProbs.reduce((a, b) => a + b, 0);
        return trueProbs.map(p => p / total);
    }

    /**
     * Calcule l'Expected Value (EV)
     */
    static calculateEV(trueProb, odds) {
        if (trueProb <= 0 || odds <= 1.0) return 0.0;
        return (trueProb * odds) - 1.0;
    }

    /**
     * Calcule la taille de mise Kelly Fractionnelle
     */
    static calculateKellyFraction(trueProb, odds, fraction = 0.25) {
        if (trueProb <= 0 || odds <= 1.0) return 0.0;
        
        const b = odds - 1.0;
        const q = 1.0 - trueProb;
        
        const kellyPct = ((b * trueProb) - q) / b;
        
        if (kellyPct <= 0) return 0.0;
        return kellyPct * fraction;
    }

    /**
     * Enrichit l'objet match avec l'analyse financière complète.
     */
    static injectFinancials(match) {
        if (!match.odds_home || !match.odds_away || !match.odds_draw) {
            return match; // Missing market data
        }

        const rawOdds = [match.odds_home, match.odds_draw, match.odds_away];
        
        // 1. Dé-juicing (Trouver la vraie probabilité du marché)
        const trueProbs = this.removeMarginShin(rawOdds);
        
        match.true_prob_home = trueProbs[0] * 100;
        match.true_prob_draw = trueProbs[1] * 100;
        match.true_prob_away = trueProbs[2] * 100;

        // 2. Calcul EV+ basé sur la probabilité de l'IA vs la cote réelle
        // L'IA estime par exemple 65% (0.65) de victoire
        const aiProbHome = (match.home_win_probability || 0) / 100;
        const aiProbDraw = (match.draw_probability || 0) / 100;
        const aiProbAway = (match.away_win_probability || 0) / 100;

        match.ev_home = this.calculateEV(aiProbHome, match.odds_home) * 100;
        match.ev_draw = this.calculateEV(aiProbDraw, match.odds_draw) * 100;
        match.ev_away = this.calculateEV(aiProbAway, match.odds_away) * 100;

        // 3. Déterminer le meilleur pari mathématique et la mise Kelly
        let evBest = 'NONE';
        let maxEv = -100;
        let kelly = 0;

        if (match.ev_home > maxEv && match.ev_home > 0) {
            maxEv = match.ev_home;
            evBest = 'HOME';
            kelly = this.calculateKellyFraction(aiProbHome, match.odds_home, 0.25);
        }
        if (match.ev_away > maxEv && match.ev_away > 0) {
            maxEv = match.ev_away;
            evBest = 'AWAY';
            kelly = this.calculateKellyFraction(aiProbAway, match.odds_away, 0.25);
        }
        if (match.ev_draw > maxEv && match.ev_draw > 0) {
            maxEv = match.ev_draw;
            evBest = 'DRAW';
            kelly = this.calculateKellyFraction(aiProbDraw, match.odds_draw, 0.25);
        }

        match.ev_best = maxEv > 0 ? evBest : 'NONE';
        match.kelly_stake = kelly * 100; // En pourcentage de la bankroll
        
        // Save initial opening odds if not set yet
        if (!match.odds_home_open && match.odds_home) {
            match.odds_home_open = match.odds_home;
            match.odds_draw_open = match.odds_draw;
            match.odds_away_open = match.odds_away;
        }

        return match;
    }
}

module.exports = QuantService;
