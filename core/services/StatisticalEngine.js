/**
 * StatisticalEngine
 * محرك الحسابات الإحصائية (توزيع بواسون، xG، توقعات الركنيات والبطاقات).
 */

const EnvironmentalIntelligence = require('../../services/EnvironmentalIntelligence');
const MomentumEngine = require('./MomentumEngine');
const thetaOptimizer = require('../../services/thetaOptimizer');
const eloService = require('../../services/eloRatingService');

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

    _logGamma(z) {
        if (z < 0.5) {
            return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - this._logGamma(1 - z)
        }
        z -= 1
        const g = 7
        const c = [
            0.99999999999980993, 676.5203681218851, -1259.1392167224028,
            771.32342877765313, -176.61502916214059, 12.507343278686905,
            -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
        ]
        let x = c[0]
        for (let i = 1; i < g + 2; i++) x += c[i] / (z + i)
        const t = z + g + 0.5
        return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
    }

    getNegBinomProb(lambda, k, theta = 4.5) {
        if (k < 0) return 0
        if (lambda <= 0) return k === 0 ? 1 : 0
        const lg1 = this._logGamma(k + theta)
        const lg2 = this._logGamma(theta)
        const lg3 = k <= 1 ? 0 : this._logGamma(k + 1)
        const logP = lg1 - lg2 - lg3
            + k * Math.log(lambda / (lambda + theta))
            + theta * Math.log(theta / (lambda + theta))
        return Math.exp(logP)
    }

    _getThetaForLeague(league) {
        if (!league) return 5.0
        const key = league.toLowerCase().trim()
        const opt = thetaOptimizer.getThetaForLeague(key)
        if (opt && opt !== 5.0) return opt
        if (key.includes('iceland') || key.includes('women') || key.includes('reykjavik')) return 3.0
        if (key.includes('bundesliga') || key.includes('netherlands') || key.includes('eredivisie')) return 3.5
        if (key.includes('premier league') || key.includes('championship') || key.includes('norway') || key.includes('sweden')) return 4.0
        if (key.includes('serie a') || key.includes('ligue 2') || key.includes('argentina') || key.includes('brazil')) return 6.0
        if (key.includes('ligue 1') || key.includes('france')) return 5.5
        if (key.includes('national') || key.includes('scotland')) return 4.5
        return 5.0
    }

    getPoissonProb(lambda, k) {
        if (k < 0) return 0;
        if (lambda <= 0) return k === 0 ? 1.0 : 0.0;
        let logP = -lambda + k * Math.log(lambda);
        for (let i = 2; i <= k; i++) logP -= Math.log(i);
        return Math.exp(logP);
    }

    getDixonColesAdj(lh, la, h, a, rho = -0.12) {
        if (h === 0 && a === 0) return 1.0 - (lh * la * rho);
        if (h === 1 && a === 0) return 1.0 + (la * rho);
        if (h === 0 && a === 1) return 1.0 + (lh * rho);
        if (h === 1 && a === 1) return 1.0 - rho;
        return 1.0;
    }

    applyGamma(xgH, xgA, gamma = 0.0) {
        if (Math.abs(gamma) < 0.001) return { h: xgH, a: xgA };
        const ratio = (xgH - xgA) / Math.max(xgH + xgA, 0.01);
        return {
            h: xgH * Math.exp(-gamma * ratio),
            a: xgA * Math.exp(gamma * ratio)
        };
    }

    getGoalModelParams(league) {
        if (!league) return { rho: -0.12, gamma: 0.0 };
        const key = league.toLowerCase().trim();
        const known = this._leagueParams;
        if (known && known[key]) return known[key];
        return { rho: -0.12, gamma: 0.0 };
    }

    /** Load league params from the DB (called once at startup) */
    loadGoalModelParams(paramsMap) {
        this._leagueParams = paramsMap || {};
    }

    _deriveXgFromOdds(m) {
        const oh = parseFloat(m.odds_home) || 2.0;
        const ox = parseFloat(m.odds_draw) || 3.0;
        const oa = parseFloat(m.odds_away) || 2.0;
        
        // Probabilités implicites
        const p_h = 1 / oh;
        const p_x = 1 / ox;
        const p_a = 1 / oa;
        const sum = p_h + p_x + p_a;
        
        // Normalisation (retrait de la marge du bookmaker)
        const nh = p_h / sum;
        const nx = p_x / sum;
        const na = p_a / sum;
        
        const leagueBase = this._getLeagueBaseXG(m.league);
        
        // Approximation simplifiée xG via probabilités
        // Un favori à 50% (cote 2.0) a généralement un xG autour de 1.5-1.8
        const xgH = nh * 3.0; 
        const xgA = na * 3.0;
        
        return { h: Math.max(0.5, xgH), a: Math.max(0.5, xgA) };
    }

    getMatchXG(m) {
        // Priority: home_xg/away_xg → teamStats averages → defaults
        const rxgH = parseFloat(m.home_xg) || 0;
        const rxgA = parseFloat(m.away_xg) || 0;
        let xgH, xgA;
        // Détection et rejet des xG stalés (typiquement <0.5 après le fatigue bug).
        // Si les xG stockés sont trop bas, on les ignore et on recalcule depuis teamStats/league.
        const xgSeemsStale = (rxgH > 0.1 && rxgA > 0.1) && (rxgH < 0.15 || rxgA < 0.15);

        if (rxgH > 0.1 && rxgA > 0.1 && !xgSeemsStale) {
            xgH = rxgH;
            xgA = rxgA;
        } else {
            let ts = m.teamStats;
            if (typeof ts === 'string') { try { ts = JSON.parse(ts); } catch(_) { ts = null; } }
            const hasRealTeamStats = ts && typeof ts === 'object' && (
                parseFloat(ts.home?.avgGoalsScored) > 0 ||
                parseFloat(ts.away?.avgGoalsScored) > 0 ||
                parseFloat(ts.home?.avgGoalsConceded) > 0 ||
                parseFloat(ts.away?.avgGoalsConceded) > 0
            );
            if (ts && typeof ts === 'object' && hasRealTeamStats) {
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
                
                const noiseH = (numHash % 40 - 20) / 40; // -0.5 to +0.5
                const noiseA = ((numHash * 3) % 40 - 20) / 40;
                
                xgH = ((hScored || (baseH + noiseH)) + (aConc || (baseA + noiseA))) / 2.0;
                xgA = ((aScored || (baseA + noiseA - 0.2)) + (hConc || (baseH + noiseH))) / 2.0;
            } else {
                // Compute xG from historical data instead of random noise
                const hStr = this.getTeamAttackDefense(m.homeTeam);
                const aStr = this.getTeamAttackDefense(m.awayTeam);
                const leagueBase = this._getLeagueBaseXG(m.league);
                if (hStr.matchCount >= 1 || aStr.matchCount >= 1) {
                    xgH = ((hStr.attack || leagueBase.h) + (aStr.defense || leagueBase.a)) / 2;
                    xgA = ((aStr.attack || leagueBase.a) + (hStr.defense || leagueBase.h)) / 2;
                    xgH = Math.max(0.3, Math.min(4.0, xgH));
                    xgA = Math.max(0.25, Math.min(4.0, xgA));
                } else {
                    const league = (m.league || '').toLowerCase();
                    const strToHash = (m.id || '') + (m.homeTeam || '') + (m.awayTeam || '') + '2';
                    let numHash = 0;
                    for (let i = 0; i < strToHash.length; i++) numHash += strToHash.charCodeAt(i);
                    const noiseFactor = (numHash % 200 - 100) / 100;
                    let baseXgH = 1.5, baseXgA = 1.15;
                    if (league.includes('iceland') || league.includes('reykjavik') || league.includes('women')) { baseXgH = 2.0; baseXgA = 1.6; }
                    else if (league.includes('bundesliga') || league.includes('netherlands')) { baseXgH = 1.8; baseXgA = 1.4; }
                    else if (league.includes('misli') || league.includes('azerbaijan')) { baseXgH = 1.7; baseXgA = 1.1; }
                    if (noiseFactor >= 0) {
                        xgH = baseXgH * (1 + noiseFactor * 0.8);
                        xgA = baseXgA * (1 - noiseFactor * 0.6);
                    } else {
                        xgH = baseXgH * (1 + noiseFactor * 0.6);
                        xgA = baseXgA * (1 - noiseFactor * 0.8);
                    }
                    xgH = Math.max(0.15, xgH);
                    xgA = Math.max(0.25, xgA);
                    
                    // 🎯 [SENSORS] Final attempt: Derive from Odds before marking insufficient
                    if (m.odds_home && m.odds_away) {
                        const derived = this._deriveXgFromOdds(m);
                        xgH = (xgH + derived.h) / 2;
                        xgA = (xgA + derived.a) / 2;
                    } else {
                        const league = (m.league || '').toLowerCase();
                        if (!league.includes('world cup')) {
                            m.insufficient_data = 1;
                        }
                    }
                }
            }
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

        // ── TIME-WEIGHTED FORM & ATTACK/DEFENSE ──
        let hPts = parseFloat(m.home_form_pts || 0);
        let aPts = parseFloat(m.away_form_pts || 0);
        if (!hPts && !aPts) {
            hPts = this.computeWeightedForm(m.homeTeam);
            aPts = this.computeWeightedForm(m.awayTeam);
        }
        if (hPts > 0 || aPts > 0) {
            const ptsDiff = hPts - aPts;
            const boost = 1 + (ptsDiff / 50);
            xgH *= (boost > 1 ? boost : 1);
            xgA *= (boost < 1 ? (1/boost) : 1);
        }

        // Time-weighted attack/defense as additional signal
        const hStr = this.getTeamAttackDefense(m.homeTeam);
        const aStr = this.getTeamAttackDefense(m.awayTeam);
        if (hStr.matchCount >= 3 && aStr.matchCount >= 3) {
            const hExpected = (hStr.attack + aStr.defense) / 2;
            const aExpected = (aStr.attack + hStr.defense) / 2;
            const leagueAvg = this._getLeagueBaseXG(m.league);
            const hNorm = hExpected / Math.max(leagueAvg.h, 0.01);
            const aNorm = aExpected / Math.max(leagueAvg.a, 0.01);
            xgH *= 0.6 + 0.4 * Math.min(hNorm, 2.0);
            xgA *= 0.6 + 0.4 * Math.min(aNorm, 2.0);
        }

        // Elo rating signal
        const elo = eloService.getMatchRatings(m.homeTeam, m.awayTeam)
        const eloDiff = elo.homeWinProb - elo.awayWinProb
        if (Math.abs(eloDiff) > 10) {
            const eloFactor = eloDiff / 100
            xgH *= 1 + eloFactor * 0.08
            xgA *= 1 - eloFactor * 0.08
        }

        return {
            h: Math.max(0.30, xgH * 1.03),
            a: Math.max(0.25, xgA * 0.98)
        };
    }

    liveAdjustXG(xgH, xgA, m) {
        if (!m || (!m.isLive && !m.liveData && !m.minute)) return { h: xgH, a: xgA }

        const live = m.liveData || {}
        const minute = parseInt(live.minute || m.minute || 45)
        const scoreH = parseInt(live.homeScore ?? live.home_score ?? m.liveHomeScore ?? 0)
        const scoreA = parseInt(live.awayScore ?? live.away_score ?? m.liveAwayScore ?? 0)
        const remaining = 90 - minute
        const isLate = minute > 70
        const isHalftime = minute >= 43 && minute <= 50

        if (isNaN(minute) || remaining <= 0) return { h: xgH, a: xgA }

        let adjH = xgH, adjA = xgA

        if (scoreH > scoreA) {
            const diff = Math.min(scoreH - scoreA, 3)
            adjA *= 1 + diff * 0.15 * (isLate ? 1.15 : 1.0)
        } else if (scoreA > scoreH) {
            const diff = Math.min(scoreA - scoreH, 3)
            adjH *= 1 + diff * 0.15 * (isLate ? 1.15 : 1.0)
        }

        if (scoreH === scoreA && isLate) {
            const urgency = (minute - 70) / 20 * 0.12
            adjH *= 1 + urgency
            adjA *= 1 + urgency
        }

        if (live.possession) {
            const posH = parseFloat(live.possession.home || live.possession)
            const posA = parseFloat(live.possession.away || (100 - posH))
            if (!isNaN(posH) && posH > 55) adjH *= 1 + (posH - 50) * 0.004
            if (!isNaN(posA) && posA > 55) adjA *= 1 + (posA - 50) * 0.004
        }

        if (live.redCards) {
            const rcH = parseInt(live.redCards.home || 0)
            const rcA = parseInt(live.redCards.away || 0)
            if (rcH > 0) adjA *= 1 + rcH * 0.25
            if (rcA > 0) adjH *= 1 + rcA * 0.25
        }

        if (isHalftime) {
            const consumedH = scoreH > 0 ? scoreH * 0.35 : 0
            const consumedA = scoreA > 0 ? scoreA * 0.35 : 0
            adjH = Math.max(adjH - consumedH, 0.15)
            adjA = Math.max(adjA - consumedA, 0.15)
        }

        const timeRatio = Math.max(remaining / 90, 0.1)
        adjH *= timeRatio
        adjA *= timeRatio

        return { h: Math.max(0.1, adjH), a: Math.max(0.1, adjA) }
    }

    _getLeagueBaseXG(league) {
        const key = (league || '').toLowerCase()
        if (key.includes('iceland') || key.includes('reykjavik') || key.includes('women')) return { h: 2.0, a: 1.6 }
        if (key.includes('bundesliga') || key.includes('netherlands') || key.includes('eredivisie') || key.includes('austria')) return { h: 1.85, a: 1.55 }
        if (key.includes('premier league') || key.includes('championship') || key.includes('norway') || key.includes('sweden')) return { h: 1.45, a: 1.25 }
        if (key.includes('misli') || key.includes('azerbaijan')) return { h: 1.7, a: 1.1 }
        if (key.includes('serie a') || key.includes('ligue 2') || key.includes('argentina') || key.includes('brazil')) return { h: 1.3, a: 1.1 }
        if (key.includes('ligue 1') || key.includes('france')) return { h: 1.25, a: 1.05 }
        if (key.includes('national') || key.includes('scotland')) return { h: 1.4, a: 1.15 }
        return { h: 1.5, a: 1.15 }
    }

    computeWeightedForm(teamName, lambda = 0.008) {
        if (!teamName) return 0
        try {
            const db = require('../database');
            if (!db || !db.db) return 0
            const rows = db.db.prepare(
                "SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp FROM historical_matches WHERE (homeTeam = ? OR awayTeam = ?) AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY timestamp DESC LIMIT 20"
            ).all(teamName, teamName)
            if (!rows || rows.length === 0) return 0
            const now = Date.now()
            let totalWeight = 0, weightedPts = 0
            for (const r of rows) {
                const daysAgo = r.timestamp ? (now - new Date(r.timestamp).getTime()) / 86400000 : 999
                if (daysAgo > 365) continue
                const w = Math.exp(-lambda * daysAgo)
                const isHome = r.homeTeam === teamName
                const gs = isHome ? r.scoreHome : r.scoreAway
                const gc = isHome ? r.scoreAway : r.scoreHome
                let pts = 0
                if (gs > gc) pts = 3
                else if (gs === gc) pts = 1
                weightedPts += w * pts
                totalWeight += w
            }
            return totalWeight > 0 ? (weightedPts / totalWeight) * 5 : 0
        } catch (_) { return 0 }
    }

    getTeamAttackDefense(teamName, lambda = 0.008) {
        if (!teamName) return { attack: 0, defense: 0, matchCount: 0 }
        try {
            const db = require('../database');
            if (!db || !db.db) return { attack: 0, defense: 0, matchCount: 0 }
            const rows = db.db.prepare(
                "SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp FROM historical_matches WHERE (homeTeam = ? OR awayTeam = ?) AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL ORDER BY timestamp DESC LIMIT 20"
            ).all(teamName, teamName)
            if (!rows || rows.length === 0) return { attack: 0, defense: 0, matchCount: 0 }
            const now = Date.now()
            let totalWeight = 0, weightedGoalsFor = 0, weightedGoalsAgainst = 0
            let matchCount = 0
            for (const r of rows) {
                const daysAgo = r.timestamp ? (now - new Date(r.timestamp).getTime()) / 86400000 : 999
                if (daysAgo > 365) continue
                const w = Math.exp(-lambda * daysAgo)
                const isHome = r.homeTeam === teamName
                const gs = isHome ? r.scoreHome : r.scoreAway
                const gc = isHome ? r.scoreAway : r.scoreHome
                weightedGoalsFor += w * gs
                weightedGoalsAgainst += w * gc
                totalWeight += w
                matchCount++
            }
            if (totalWeight === 0) return { attack: 0, defense: 0, matchCount: 0 }
            return {
                attack: weightedGoalsFor / totalWeight,
                defense: weightedGoalsAgainst / totalWeight,
                matchCount
            }
        } catch (_) { return { attack: 0, defense: 0, matchCount: 0 } }
    }

    /**
     * calculatePoissonProbs
     * Bridge method for QuantumQuantEngine
     */
    calculatePoissonProbs(xgH, xgA, m = {}, opts = {}) {
        const full = this.calculateMarketProbs(xgH, xgA, { ...opts, league: m.league || opts.league });
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
    calculateMarketProbs(xgH, xgA, opts = {}) {
        const rho = opts.rho || -0.12;
        const gamma = opts.gamma || 0.0;
        const theta = opts.theta || this._getThetaForLeague(opts.league) || 5.0;
        const useNB = opts.useNegBinom !== false;
        const { h: xgHadj, a: xgAadj } = this.applyGamma(xgH, xgA, gamma);
        let pH = 0, pD = 0, pA = 0;
        let pBTTS = 0, pBTTS_NO = 0;
        let pOU = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
        let pU = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
        
        // Advanced Markets
        let pCleanSheetH = 0, pCleanSheetA = 0;
        let pScoreFirstH = xgHadj / (xgHadj + xgAadj || 1);
        let pAH = { 'H-1.5': 0, 'H-1': 0, 'A-1.5': 0, 'A-1': 0, 'H+1': 0, 'A+1': 0 };
        let pEH = { 'H-1': 0, 'A-1': 0 };
        
        // Combo Probabilities
        let pWinAndO25 = 0;
        let p1XAndO15 = 0;
        let p1XAndBTTS = 0;
        let pX2AndU35 = 0;

        const distFn = useNB
            ? (l, k) => this.getNegBinomProb(l, k, theta)
            : (l, k) => this.getPoissonProb(l, k);

        for (let h = 0; h <= 10; h++) {
            const probH = distFn(xgHadj, h);
            for (let a = 0; a <= 10; a++) {
                const probA = distFn(xgAadj, a);
                const dc = this.getDixonColesAdj(xgHadj, xgAadj, h, a, rho);
                const prob = probH * probA * dc;
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

        // ── BTTS REALITY BOOST ──
        // Pure Poisson under-predicts BTTS in high-scoring games
        const totalXG = xgHadj + xgAadj;
        let bttsFactor = 1.0;
        if (totalXG > 2.8) bttsFactor = 1.25; // +25% boost for high xG
        else if (totalXG < 1.8) bttsFactor = 0.75; // -25% for very low xG

        let finalBTTS = pBTTS * bttsFactor;
        finalBTTS = Math.min(0.95, Math.max(0.05, finalBTTS));
        const finalBTTS_NO = 1 - finalBTTS;

        return {
            win: { home: pH, draw: pD, away: pA },
            dc: { '1X': pH + pD, 'X2': pA + pD, '12': pH + pA },
            btts: { yes: finalBTTS, no: finalBTTS_NO },
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
    findMostProbableScore(xgH, xgA, opts = {}) {
        const rho = opts.rho || -0.12;
        const gamma = opts.gamma || 0.0;
        const theta = opts.theta || this._getThetaForLeague(opts.league) || 5.0;
        const useNB = opts.useNegBinom !== false;
        const { h: xgHadj, a: xgAadj } = this.applyGamma(xgH, xgA, gamma);
        let maxProb = -1;
        let bestScore = "1 - 1";
        
        const distFn = useNB
            ? (l, k) => this.getNegBinomProb(l, k, theta)
            : (l, k) => this.getPoissonProb(l, k);

        for (let h = 0; h <= 7; h++) {
            const probH = distFn(xgHadj, h);
            for (let a = 0; a <= 7; a++) {
                const probA = distFn(xgAadj, a);
                const dc = this.getDixonColesAdj(xgHadj, xgAadj, h, a, rho);
                const prob = probH * probA * dc;
                
                // ── DOMINANCE BIAS & REGRESSION ──
                // On évite les scores trop extrêmes (3-0, 0-3) quand on est en mode fallback
                let finalProb = prob;
                const xgDiff = Math.abs(xgHadj - xgAadj);
                
                if (h >= 3 || a >= 3) {
                    finalProb *= 0.7; // Pénalise les scores élevés (ex: 3-0) pour favoriser le réalisme
                }
                if (h === 1 && a === 1 && xgDiff > 0.8) {
                    finalProb *= 0.8; // Pénalise le 1-1 quand il y a une vraie dominance
                }

                if (finalProb > maxProb) {
                    maxProb = finalProb;
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
        
        const theta = this._getThetaForLeague(league)
        const distFn = (l, k) => this.getNegBinomProb(l, k, theta)

        let pH_ht = 0, pD_ht = 0, pA_ht = 0;
        let pOU05_ht = 0, pOU15_ht = 0;
        let pBTTS_ht = 0;
        let pGoalInHT = 0;

        for (let h = 0; h <= 6; h++) {
            const probH = distFn(h_ht, h);
            for (let a = 0; a <= 6; a++) {
                const probA = distFn(a_ht, a);
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
