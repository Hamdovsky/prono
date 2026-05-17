/**
 * StatisticalEngine
 * محرك الحسابات الإحصائية (توزيع بواسون، xG، توقعات الركنيات والبطاقات).
 */

const EnvironmentalIntelligence = require('../../services/EnvironmentalIntelligence');
const MomentumEngine = require('./MomentumEngine');

class StatisticalEngine {
    predictCorners(match, winnerProbability) {
        let baseCorners = 8;
        const leagueName = (match.league || '').toLowerCase();
        
        if (leagueName.includes('premier league') || leagueName.includes('champions')) {
            baseCorners = 10;
        } else if (leagueName.includes('serie a') || leagueName.includes('bundesliga')) {
            baseCorners = 9;
        } else if (leagueName.includes('ligue 1') || leagueName.includes('la liga') || leagueName.includes('league one') || leagueName.includes('national league')) {
            baseCorners = 9;
        }

        if (winnerProbability > 0.65) {
            baseCorners += 2;
        }

        const variation = Math.floor(Math.random() * 4) - 2;
        return Math.max(4, Math.min(16, baseCorners + variation));
    }

    predictCards(match) {
        let baseCards = 3;
        const leagueName = (match.league || '').toLowerCase();
        
        if (leagueName.includes('premier league') || leagueName.includes('serie a')) {
            baseCards = 4;
        } else if (leagueName.includes('la liga') || leagueName.includes('league one') || leagueName.includes('national league')) {
            baseCards = 5;
        }

        if (match.confidence < 55) {
            baseCards += 1;
        }

        if (match.referee_id || match.referee_yellow_avg > 0) {
            const refProfile = EnvironmentalIntelligence.profileReferee({
                yellow_avg: match.referee_yellow_avg,
                red_avg: match.referee_red_avg,
                penalties_avg: match.referee_penalties_avg
            });
            if (refProfile.tier === 'STRICT') baseCards += 1.5;
            else if (refProfile.tier === 'LENIENT') baseCards -= 1.0;
        }

        const variation = Math.floor(Math.random() * 3) - 1;
        return Math.max(1, Math.min(10, baseCards + variation));
    }

    predictGoals(match, winnerProbability) {
        let baseGoals = 2.5;
        const leagueName = (match.league || '').toLowerCase();
        
        if (leagueName.includes('bundesliga') || leagueName.includes('eredivisie') || leagueName.includes('iceland')) {
            baseGoals = 3.3;
        } else if (leagueName.includes('premier league') || leagueName.includes('norway') || leagueName.includes('sweden')) {
            baseGoals = 2.9;
        } else if (leagueName.includes('serie a') || leagueName.includes('league one') || leagueName.includes('laliga')) {
            baseGoals = 2.5;
        } else if (leagueName.includes('national league') || leagueName.includes('scotland')) {
            baseGoals = 2.7;
        }

        if (winnerProbability > 0.7) {
            baseGoals += 0.5;
        } else if (winnerProbability < 0.4) {
            baseGoals -= 0.3;
        }

        const variation = (Math.random() - 0.5) * 1.5;
        const totalGoals = Math.max(0, baseGoals + variation);
        return Math.round(totalGoals * 2) / 2;
    }

    getPoissonProb(lambda, k) {
        if (k < 0) return 0;
        if (lambda <= 0) return k === 0 ? 1.0 : 0.0;
        let logP = -lambda + k * Math.log(lambda);
        for (let i = 2; i <= k; i++) logP -= Math.log(i);
        return Math.exp(logP);
    }

    getMatchXG(m) {
        // Priority: home_xg/away_xg → teamStats averages → defaults
        const rxgH = parseFloat(m.home_xg) || 0;
        const rxgA = parseFloat(m.away_xg) || 0;
        let xgH, xgA;

        if (rxgH > 0.1 && rxgA > 0.1) {
            xgH = rxgH;
            xgA = rxgA;
        } else {
            let ts = m.teamStats;
            if (typeof ts === 'string') { try { ts = JSON.parse(ts); } catch(_) { ts = null; } }
            if (ts && typeof ts === 'object') {
                const hs = ts.home || {};
                const as = ts.away || {};
                const hScored = parseFloat(hs.avgGoalsScored) || 0;
                const hConc   = parseFloat(hs.avgGoalsConceded) || 0;
                const aScored = parseFloat(as.avgGoalsScored) || 0;
                const aConc   = parseFloat(as.avgGoalsConceded) || 0;
                
                // League-specific base xG if team data is low
                const league = (m.league || '').toLowerCase();
                let baseH = 1.35, baseA = 1.15;
                if (league.includes('iceland') || league.includes('reykjavik')) { baseH = 1.95; baseA = 1.65; }
                else if (league.includes('bundesliga') || league.includes('netherlands') || league.includes('austria')) { baseH = 1.85; baseA = 1.55; }
                else if (league.includes('premier league') || league.includes('championship')) { baseH = 1.45; baseA = 1.25; }
                else if (league.includes('serie a') || league.includes('italy')) { baseH = 1.3; baseA = 1.1; }
                else if (league.includes('ligue 1') || league.includes('france') || league.includes('national 1')) { baseH = 1.25; baseA = 1.05; }
                else if (league.includes('women')) { baseH = 2.1; baseA = 1.8; }
                else if (league.includes('misli') || league.includes('azerbaijan')) { baseH = 1.6; baseA = 1.1; }

                // Add slight randomization to prevent identical fallbacks (Titanium Noise V2)
                const strToHash = (m.id || '') + (m.homeTeam || '') + (m.awayTeam || '') + '1';
                let numHash = 0;
                for (let i = 0; i < strToHash.length; i++) numHash += strToHash.charCodeAt(i);
                
                const noiseH = (numHash % 20 - 10) / 50; // -0.2 to +0.2
                const noiseA = ((numHash * 3) % 20 - 10) / 50;

                xgH = ((hScored || (baseH + noiseH)) + (aConc || (baseA + noiseA))) / 2.0;
                xgA = ((aScored || (baseA + noiseA - 0.2)) + (hConc || (baseH + noiseH))) / 2.0;
                
                if (!hScored && !aScored && !hConc && !aConc) m.insufficient_data = 1;
            } else {
                const league = (m.league || '').toLowerCase();
                const strToHash = (m.id || '') + (m.homeTeam || '') + (m.awayTeam || '') + '2';
                let numHash = 0;
                for (let i = 0; i < strToHash.length; i++) numHash += strToHash.charCodeAt(i);
                const noise = (numHash % 30 - 15) / 30; // Increased noise range: -0.5 to +0.5
                
                if (league.includes('iceland') || league.includes('reykjavik')) { xgH = 2.0 + noise; xgA = 1.7 - (noise * 0.8); }
                else if (league.includes('bundesliga')) { xgH = 1.85 + noise; xgA = 1.5 - (noise * 0.7); }
                else if (league.includes('women')) { xgH = 2.2 + noise; xgA = 1.9 - (noise * 0.9); }
                else if (league.includes('misli') || league.includes('azerbaijan')) { xgH = 1.7 + noise; xgA = 1.1 - (noise * 0.5); }
                else if (league.includes('national 1')) { xgH = 1.2 + noise; xgA = 1.0 - (noise * 0.4); }
                else { xgH = 1.45 + noise; xgA = 1.15 - (noise * 0.6); }
                
                m.insufficient_data = 1;
            }
        }

        // 🚀 [TITANIUM V55] Environmental & Form Intelligence
        const weather = EnvironmentalIntelligence.analyzeWeather({
            temp: m.weather_temp,
            desc: m.weather_desc,
            humidity: m.weather_humidity
        });

        // Weather impact on total goals (goalMod is a percentage drop/gain)
        if (weather.goalMod !== 0) {
            const mod = 1 + (weather.goalMod / 100);
            xgH *= mod;
            xgA *= mod;
        }

        // 🚀 [MOMENTUM ALPHA] Ultra-recent form boost
        const trendH = MomentumEngine.getTrend(m.homeTeam);
        const trendA = MomentumEngine.getTrend(m.awayTeam);
        xgH *= trendH;
        xgA *= trendA;

        // Form Points Impact (Long term form)
        const hPts = parseFloat(m.home_form_pts || 0);
        const aPts = parseFloat(m.away_form_pts || 0);
        if (hPts > 0 || aPts > 0) {
            const ptsDiff = hPts - aPts;
            const boost = 1 + (ptsDiff / 50); // Small 2% boost per 1pt diff
            xgH *= (boost > 1 ? boost : 1);
            xgA *= (boost < 1 ? (1/boost) : 1);
        }

        return { 
            h: Math.max(0.45, xgH * 1.03), 
            a: Math.max(0.41, xgA * 0.98) 
        };
    }

    /**
     * calculatePoissonProbs
     * Bridge method for QuantumQuantEngine
     */
    calculatePoissonProbs(xgH, xgA, m = {}) {
        const full = this.calculateMarketProbs(xgH, xgA);
        const ht = this.calculateFirstHalfProbs(xgH, xgA, m);
        return {
            ...full,
            first_half: ht,
            over25: full.ou[2.5],
            under25: full.u[2.5],
            over35: full.ou[3.5],
            ht_goal: ht.goal_yes
        };
    }

    /**
     * calculateMarketProbs
     * Computes raw probabilities for multiple markets using Poisson Matrix.
     */
    calculateMarketProbs(xgH, xgA) {
        let pH = 0, pD = 0, pA = 0;
        let pBTTS = 0, pBTTS_NO = 0;
        let pOU = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
        let pU = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
        
        // Advanced Markets
        let pCleanSheetH = 0, pCleanSheetA = 0;
        let pScoreFirstH = xgH / (xgH + xgA || 1); // Simple approximation for score first
        let pAH = { 'H-1.5': 0, 'H-1': 0, 'A-1.5': 0, 'A-1': 0, 'H+1': 0, 'A+1': 0 };
        let pEH = { 'H-1': 0, 'A-1': 0 };
        
        // Combo Probabilities
        let pWinAndO25 = 0;
        let p1XAndO15 = 0;
        let p1XAndBTTS = 0;
        let pX2AndU35 = 0;

        for (let h = 0; h <= 10; h++) {
            const probH = this.getPoissonProb(xgH, h);
            for (let a = 0; a <= 10; a++) {
                const probA = this.getPoissonProb(xgA, a);
                const prob = probH * probA;
                const total = h + a;
                const diff = h - a;

                // 1X2
                if (h > a) pH += prob;
                else if (h === a) pD += prob;
                else pA += prob;

                // BTTS
                if (h > 0 && a > 0) pBTTS += prob;
                else pBTTS_NO += prob;

                // Over/Under
                [0.5, 1.5, 2.5, 3.5, 4.5].forEach(line => {
                    if (total > line) pOU[line] += prob;
                    else pU[line] += prob;
                });

                // Clean Sheets
                if (a === 0) pCleanSheetH += prob;
                if (h === 0) pCleanSheetA += prob;

                // Handicaps
                if (diff > 1.5) pAH['H-1.5'] += prob;
                if (diff > 1) pAH['H-1'] += prob; // Win by 2+
                else if (diff === 1) pAH['H-1'] += prob * 0.5; // Half-win/Push logic simplified
                
                if (diff < -1.5) pAH['A-1.5'] += prob;
                if (diff < -1) pAH['A-1'] += prob;

                if (diff > -1) pAH['H+1'] += prob;
                if (diff < 1) pAH['A+1'] += prob;

                // European Handicap (EH -1 means Win by 2+)
                if (diff >= 2) pEH['H-1'] += prob;
                if (diff <= -2) pEH['A-1'] += prob;

                // Combos
                if (h > a && total > 2.5) pWinAndO25 += prob;
                if (h >= a && total > 1.5) p1XAndO15 += prob;
                if (h >= a && h > 0 && a > 0) p1XAndBTTS += prob;
                if (a >= h && total < 3.5) pX2AndU35 += prob;
            }
        }

        // Normalize 1X2
        const totalProb = pH + pD + pA;
        if (totalProb > 0) { pH /= totalProb; pD /= totalProb; pA /= totalProb; }

        return {
            win: { home: pH, draw: pD, away: pA },
            dc: { '1X': pH + pD, 'X2': pA + pD, '12': pH + pA },
            btts: { yes: pBTTS, no: pBTTS_NO },
            ou: pOU,
            u: pU,
            cs: { home: pCleanSheetH, away: pCleanSheetA },
            sf: { home: pScoreFirstH, away: 1 - pScoreFirstH },
            ah: pAH,
            eh: pEH,
            combos: {
                'Win_O25': pWinAndO25,
                '1X_O15': p1XAndO15,
                '1X_BTTS': p1XAndBTTS,
                'X2_U35': pX2AndU35
            }
        };
    }

    /**
     * findMostProbableScore
     * Finds the exact score with the absolute highest probability (Poisson Mode).
     */
    findMostProbableScore(xgH, xgA) {
        let maxProb = -1;
        let bestScore = "1 - 1";
        
        for (let h = 0; h <= 5; h++) {
            const probH = this.getPoissonProb(xgH, h);
            for (let a = 0; a <= 5; a++) {
                const probA = this.getPoissonProb(xgA, a);
                const prob = probH * probA;
                
                if (prob > maxProb) {
                    maxProb = prob;
                    bestScore = `${h} - ${a}`;
                }
            }
        }
        return bestScore;
    }

    /**
     * calculateFirstHalfProbs
     * Estimates HT markets (λ_HT = λ_FT * 0.44)
     */
    calculateFirstHalfProbs(xgH, xgA, m = {}) {
        // 🚀 [TITANIUM DYNAMIC HT] No longer static 0.44.
        const league = (m.league || '').toLowerCase();
        let htRatio = 0.44; // Default Global

        if (league.includes('iceland') || league.includes('women')) htRatio = 0.52;
        else if (league.includes('bundesliga') || league.includes('netherlands')) htRatio = 0.48;
        else if (league.includes('serie a') || league.includes('italy')) htRatio = 0.42;
        else if (league.includes('ligue 2') || league.includes('argentina')) htRatio = 0.38;
        else if (league.includes('brazil')) htRatio = 0.40;
        
        const h_ht = xgH * htRatio * MomentumEngine.getHTMomentum(m.homeTeam);
        const a_ht = xgA * htRatio * MomentumEngine.getHTMomentum(m.awayTeam);
        
        let pH_ht = 0, pD_ht = 0, pA_ht = 0;
        let pOU05_ht = 0, pOU15_ht = 0;
        let pBTTS_ht = 0;
        let pGoalInHT = 0;

        for (let h = 0; h <= 6; h++) {
            const probH = this.getPoissonProb(h_ht, h);
            for (let a = 0; a <= 6; a++) {
                const probA = this.getPoissonProb(a_ht, a);
                const prob = probH * probA;

                if (h > a) pH_ht += prob;
                else if (h === a) pD_ht += prob;
                else pA_ht += prob;

                if (h + a > 0.5) {
                    pOU05_ht += prob;
                    pGoalInHT += prob;
                }
                if (h + a > 1.5) pOU15_ht += prob;
                if (h > 0 && a > 0) pBTTS_ht += prob;
            }
        }

        const totalHT = pH_ht + pD_ht + pA_ht;
        return {
            win: { home: pH_ht/totalHT, draw: pD_ht/totalHT, away: pA_ht/totalHT },
            dc: { '1X': (pH_ht + pD_ht)/totalHT, 'X2': (pA_ht + pD_ht)/totalHT, '12': (pH_ht + pA_ht)/totalHT },
            ou05: pOU05_ht,
            ou15: pOU15_ht,
            btts: pBTTS_ht,
            goal_yes: pGoalInHT,
            goal_no: 1 - pGoalInHT
        };
    }
}

module.exports = new StatisticalEngine();
