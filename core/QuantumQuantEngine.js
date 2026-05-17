const StatisticalEngine = require('./services/StatisticalEngine');

class QuantumQuantEngine {
    
    analyze(m, xgH, xgA) {
        // 1. Probabilités de base via Poisson (Enrichi par le contexte ligue)
        const probs = StatisticalEngine.calculatePoissonProbs(xgH, xgA, m);
        
        // 2. Générer les marchés avec cotes réelles si disponibles
        const markets = this._generateMarkets(probs, m);
        
        // 3. Classer par Intelligence (Safety vs Value)
        const ranked = this._rankMarkets(markets, m);

        return {
            markets,
            main_pick: ranked.main.val,
            secondary_pick: ranked.secondary.label,
            ev_score: ranked.secondary.ev.toFixed(2),
            edge_score: ranked.secondary.edge.toFixed(2),
            risk_label: this._getRiskLabel(ranked.main.prob),
            expected_score: StatisticalEngine.findMostProbableScore(xgH, xgA),
            confidence: Math.round(ranked.main.prob * 100),
            momentum: {
                home: require('./services/MomentumEngine').getTrend(m.homeTeam),
                away: require('./services/MomentumEngine').getTrend(m.awayTeam)
            },
            all_picks: ranked.all.slice(0, 4),
            probs: {
                btts: Math.round(probs.btts.yes * 100),
                over25: Math.round(probs.over25 * 100),
                ht_goal: Math.round(probs.ht_goal * 100)
            }
        };
    }

    _generateMarkets(p, m) {
        const ht = p.first_half;
        
        const calcEV = (prob, odds) => (prob * (odds || 2.0)) - 1;

        const markets = {
            match_result: {
                '1': { prob: p.win.home, odds: m.odds_home, ev: calcEV(p.win.home, m.odds_home) },
                'X': { prob: p.win.draw, odds: m.odds_draw, ev: calcEV(p.win.draw, m.odds_draw) },
                '2': { prob: p.win.away, odds: m.odds_away, ev: calcEV(p.win.away, m.odds_away) }
            },
            over_under: {
                'O2.5': { prob: p.over25, odds: m.odds_over25 || 1.85, ev: calcEV(p.over25, m.odds_over25 || 1.85) },
                'U2.5': { prob: p.under25, odds: m.odds_under25 || 1.95, ev: calcEV(p.under25, m.odds_under25 || 1.95) },
                'O3.5': { prob: p.over35, odds: 3.2, ev: calcEV(p.over35, 3.2) }
            },
            btts: {
                'YES': { prob: p.btts.yes, odds: m.odds_btts_yes || 1.80, ev: calcEV(p.btts.yes, m.odds_btts_yes || 1.80) },
                'NO':  { prob: p.btts.no,  odds: m.odds_btts_no || 2.05,  ev: calcEV(p.btts.no,  m.odds_btts_no || 2.05) }
            },
            double_chance: {
                '1X': { prob: p.dc['1X'], odds: 1.3, ev: calcEV(p.dc['1X'], 1.3) },
                'X2': { prob: p.dc['X2'], odds: 1.6, ev: calcEV(p.dc['X2'], 1.6) },
                '12': { prob: p.dc['12'], odds: 1.25, ev: calcEV(p.dc['12'], 1.25) }
            }
        };

        return markets;
    }

    _rankMarkets(markets, m) {
        const ranked = [];
        
        for (const [cat, choices] of Object.entries(markets)) {
            for (const [val, data] of Object.entries(choices)) {
                const prob = data.prob;
                const odds = data.odds || 0;
                
                // --- [INTELLIGENCE: BEAT THE BOOKIE] ---
                // Implied Prob = 1 / Odds
                const impliedProb = odds > 0 ? (1 / odds) : 0;
                const edge = (impliedProb > 0) ? (prob - impliedProb) : 0;
                
                // EV Score (ROI theoretical)
                const ev = odds > 0 ? (prob * odds) - 1 : 0;

                // Smart Score logic:
                // 1. Probabilité brute (Sécurité)
                // 2. Edge (Battre le bookmaker) - Poids fort pour l'intelligence
                // 3. EV (Rentabilité long terme)
                const smartScore = (prob * 50) + (edge * 150) + (ev * 30);

                ranked.push({
                    cat, val, prob, odds, ev, edge,
                    smartScore,
                    label: this._getLabel(cat, val)
                });
            }
        }

        // TIER 1: MAIN pick = Toujours le 1X2 le plus probable (La base solide)
        const matchResultMarkets = ranked.filter(r => r.cat === 'match_result');
        const mainPick = matchResultMarkets.sort((a, b) => b.prob - a.prob)[0];

        // TIER 2: SECONDARY = La meilleure "VALEUR" (L'intelligence pour battre le bookie)
        // On cherche le marché qui a le meilleur SmartScore
        const secondaryPool = ranked.filter(r => 
            r.label !== mainPick.label && // Pas de doublon
            r.prob > 0.35 // Qualité minimum
        );
        
        const secondaryPicks = secondaryPool.sort((a, b) => b.smartScore - a.smartScore);
        
        // --- [NEW: MASSIVE EDGE DETECTION] ---
        const bestValue = secondaryPicks[0] || mainPick;
        const isMassive = (bestValue.edge > 0.12 && bestValue.prob > 0.50);
        const signalStrength = Math.min(100, Math.round((bestValue.edge * 400) + (bestValue.prob * 40)));

        return {
            main: mainPick,
            secondary: bestValue,
            all: secondaryPicks,
            massive_edge: isMassive,
            signal_strength: signalStrength
        };
    }

    _getLabel(cat, val) {
        const catNames = {
            'match_result': '',
            'over_under': 'O/U ',
            'btts': 'BTTS: ',
            'double_chance': 'DC: ',
            'first_half': 'HT: ',
            'handicap': 'H: '
        };
        return `${catNames[cat] || ''}${val}`;
    }

    _getRiskLabel(prob) {
        if (prob > 0.75) return 'SAFE';
        if (prob > 0.60) return 'STABLE';
        if (prob > 0.45) return 'MODERATE';
        return 'RISKY';
    }
}

module.exports = new QuantumQuantEngine();
