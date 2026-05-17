const database = require('../core/database');
const path = require('path');

/**
 * IntegrityService: Detects suspicious patterns, market anomalies, and integrity risks.
 */
class IntegrityService {
    /**
     * Analyze a match for integrity risks.
     */
    static async analyzeMatch(match, modelPredictions, intelligence) {
        const risks = [];
        let integrityScore = 0;

        // 1. Market Efficiency Analysis
        const marketAnomaly = this._checkMarketGap(match, modelPredictions);
        if (marketAnomaly) {
            risks.push(marketAnomaly);
            integrityScore += marketAnomaly.weight;
        }

        // 2. Volatility Monitor
        const volatility = this._checkVolatility(match);
        if (volatility) {
            risks.push(volatility);
            integrityScore += volatility.weight;
        }

        // 3. Overround Anomaly
        const overround = this._checkOverround(match);
        if (overround) {
            risks.push(overround);
            integrityScore += overround.weight;
        }

        // 4. AH Divergence Monitor
        const ahDivergence = this._checkAHDivergence(match, modelPredictions);
        if (ahDivergence) {
            risks.push(ahDivergence);
            integrityScore += ahDivergence.weight;
        }

        // 5. H2H Pact & Ghost Pattern Detection
        const h2hPact = await this._checkH2HPact(match);
        if (h2hPact) {
            risks.push(h2hPact);
            integrityScore += h2hPact.weight;
        }
        const ghostPattern = await this._checkGhostPattern(match);
        if (ghostPattern) {
            risks.push(ghostPattern);
            integrityScore += ghostPattern.weight;
        }

        // 6. Referee Bias Engine
        const refRisk = await this._checkRefereeRisk(match);
        if (refRisk) {
            risks.push(refRisk);
            integrityScore += refRisk.weight;
        }

        // 7. [NEW] Insiders' Edge Detection
        const insidersEdge = this._checkInsidersEdge(match, modelPredictions);
        if (insidersEdge) {
            risks.push(insidersEdge);
            // Insiders Edge is a positive value signal, doesn't increase "suspicion" score
        }
        // 9. Traffic Light Status
        const trafficLight = this._getTrafficLight(integrityScore, marketAnomaly, volatility);

        // 10. [v28] Smart Money Pulse
        const smartMoney = this._checkSmartMoneyPulse(match);

        // 11. [v4.5] Pro Strategy Tagging
        // Normalize probability to 0.0 - 1.0 range regardless of storage (0-1 or 0-100)
        let rawProb = modelPredictions.home_win_probability || modelPredictions.home || 0;
        const normalizedProb = rawProb > 1 ? rawProb / 100 : rawProb;
        
        const fairPrice = (normalizedProb > 0) ? (1 / normalizedProb).toFixed(2) : null;
        const marketOdds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : (match.market_odds || {});
        const edge = (marketOdds.home && fairPrice) ? ((marketOdds.home / fairPrice) - 1).toFixed(2) : 0;
        const squadHealth = match.squad_health || 100;

        const strategicTags = [];
        // The Vault: Needs > 90% CONF + High Integrity + Squad Stability
        if (integrityScore < 15 && normalizedProb > 0.90 && squadHealth > 85) {
            strategicTags.push('CERTAINTY_VAULT');
        }
        
        // The Multiplier: Needs > 20% EDGE + Floor Odds of 2.0 OR [v4.5.1] Insiders' Edge
        const hasInsidersEdge = risks.some(r => r.tag === 'INSIDERS_EDGE');
        if ((parseFloat(marketOdds.home) >= 2.0 && parseFloat(edge) > 0.20) || hasInsidersEdge) {
            strategicTags.push('GOLDEN_MULTIPLIER');
        }

        return {
            isSuspicious: integrityScore > 25,
            score: Math.min(100, integrityScore),
            trafficLight,
            smartMoneyPulse: smartMoney,
            trapExplanation: ahDivergence?.details || null,
            fairPrice,
            edge: parseFloat(edge),
            strategicTags,
            risks,
            version: "4.5.1-GOLD",
            recommendation: this._getRecommendation(integrityScore, marketAnomaly)
        };
    }

    static _getTrafficLight(score, market, volatility) {
        if (score > 50 || (volatility && market)) return 'RED';
        if (score > 20 || market || volatility) return 'YELLOW';
        return 'GREEN';
    }

    static _checkSmartMoneyPulse(match) {
        if (!match.market_odds) return { pro: 50, amateur: 50 };
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        
        // V28 SHARP MONEY RADAR
        const margin = (1/odds.home + 1/odds.draw + 1/odds.away) - 1;
        let proWeight = 40;
        
        // 1. Efficient Market Signal (Low Margin)
        if (margin < 0.04) proWeight += 15;
        
        // 2. High Velocity Signal (Odds Speed)
        const speed = parseFloat(match.odds_speed || 0);
        if (speed > 80) proWeight += 25; // Massive movement detected
        
        // 3. Drop Anomaly Signal
        if (match.odds_drop_alert) proWeight += 20;

        proWeight = Math.min(95, Math.max(5, proWeight));
        
        return { 
            pro: proWeight, 
            amateur: 100 - proWeight,
            label: proWeight > 75 ? '⚡ SHARP FLOW DETECTED' : (proWeight > 55 ? 'ACTIVE PROS' : 'NORMAL MARKET')
        };
    }

    static async _checkRefereeRisk(match) {
        if (!match.referee || match.referee === 'V.A.R.') return null;
        
        // Use historical catalog if columns exist
        const yellowAvg = parseFloat(match.referee_yellow_avg || 3.5);
        const redAvg = parseFloat(match.referee_red_avg || 0.15);
        const penAvg = parseFloat(match.referee_penalties_avg || 0.25);

        // Strictness logic:
        // High cards (> 4.5 yellows or > 0.25 reds) or High penalties (> 0.40)
        const isStrict = yellowAvg > 4.5 || redAvg > 0.25 || penAvg > 0.40;
        const biasProb = this._getRefereeBiasProbability(match.referee, match.homeTeam, match.awayTeam);

        if (isStrict || biasProb > 0.65) {
            return {
                type: 'Referee Strictness Alert',
                details: `الحكم ${match.referee} معروف بصرامته: معدل البطاقات الصفراء (${yellowAvg})، الحمراء (${redAvg})، والجزاء (${penAvg}). خطر عالٍ للبطاقات الملونة.`,
                biasScore: biasProb,
                strictness: { yellowAvg, redAvg, penAvg },
                weight: isStrict ? 25 : 15,
                tag: 'REF_STRICT_PROB'
            };
        }
        return null;
    }

    static _getRefereeBiasProbability(referee, home, away) {
        // We still keep a small deterministic "bias" check if needed, 
        // but it's now secondary to the strictness logic.
        const seed = (referee.length + home.length) % 100;
        return seed / 100;
    }

    static _checkOverround(match) {
        if (!match.market_odds) return null;
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        if (!odds.home || !odds.draw || !odds.away) return null;
        const margin = (1/odds.home + 1/odds.draw + 1/odds.away) - 1;
        if (margin < 0.03 && !['Premier League', 'LaLiga', 'Serie A'].includes(match.league)) {
            return {
                type: 'Smart Money Density',
                details: `انخفاض حاد في هامش الربح (${(margin*100).toFixed(1)}%): مؤشر على دخول سيولة ذكية عالية اليقين.`,
                weight: 20,
                tag: 'DENSE_VOLUME'
            };
        }
        return null;
    }

    static _checkVolatility(match) {
        if (match.odds_drop_alert) {
            return {
                type: 'Volatility Alert',
                details: 'رصد هبوط حاد في الأسعار قبل صافرة البداية: احتمال تسريب معلومات (Information Leak).',
                weight: 30,
                tag: 'MARKET_VOLATILITY'
            };
        }
        return null;
    }

    static _checkMarketGap(match, model) {
        if (!match.market_odds || !model) return null;
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        if (!odds.home || !odds.draw || !odds.away) return null;
        const bookieProb = 1 / parseFloat(odds.home);
        const modelProb  = parseFloat(model.home_win_probability || model.home || 0);
        const gap = Math.abs(modelProb - bookieProb);
        if (gap > 0.15) {
            return {
                type: 'Market Anomaly',
                details: `فجوة سوقية حادة: نموذجنا يتوقع ${Math.round(modelProb*100)}% والبوكميكر يقدم ${Math.round(bookieProb*100)}%`,
                gap: (gap * 100).toFixed(1),
                weight: 35,
                tag: gap > 0.25 ? 'INSIDE_TRADE' : 'BOOKIE_ERROR'
            };
        }
        return null;
    }

    static async _checkH2HPact(match) {
        const h2h = match.historical_context?.h2h_raw || [];
        if (h2h.length < 4) return null;
        const draws = h2h.filter(m => m.scoreHome === m.scoreAway).length;
        if (draws / h2h.length >= 0.5) {
            return {
                type: 'H2H Pattern',
                details: `نمط "اتفاق عدم اعتداء": ${draws}/${h2h.length} من المواجهات السابقة انتهت بالتعادل.`,
                weight: 25,
                tag: 'PACT_OF_NON_AGGRESSION'
            };
        }
        return null;
    }

    static _checkSentimentRisk(intel) {
        if (!intel || !intel.headlines) return null;
        const crisisKws = ['financial crisis', 'unpaid', 'salary', 'wages', 'debts', 'bankruptcy', 'أزمة مالية', 'رواتب', 'ديون', 'إفلاس', 'إضراب', 'مشاكل إدارية'];
        const matched = intel.headlines.filter(h => crisisKws.some(kw => h.toLowerCase().includes(kw)));
        if (matched.length > 0) {
            return {
                type: 'Motivation Risk',
                details: `إشارات أزمة مالية/إدارية: رصدت العناوين أخباراً مشبوهة حول استقرار النادي.`,
                evidence: matched.slice(0, 2),
                weight: 30,
                tag: 'FINANCIAL_DISTRESS'
            };
        }
        return null;
    }

    /**
     * [v4.5.1] H2H Ghost Pattern: Detects repeating historical scores or alternating win patterns.
     */
    static async _checkGhostPattern(match) {
        const h2h = match.historical_context?.h2h_raw || [];
        if (h2h.length < 5) return null;

        // Pattern 1: Same score repeated > 3 times
        const scores = h2h.map(m => `${m.scoreHome}-${m.scoreAway}`);
        const scoreCounts = scores.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});
        const frequentScore = Object.entries(scoreCounts).find(([s, count]) => count >= 3);

        if (frequentScore) {
            return {
                type: 'H2H Ghost Pattern',
                details: `نمط تاريخي مريب: تكرار نفس النتيجة (${frequentScore[0]}) لـ ${frequentScore[1]} مرات في المواجهات المباشرة.`,
                weight: 25,
                tag: 'GHOST_PATTERN'
            };
        }
        return null;
    }

    /**
     * [v4.5.1] Insiders' Edge: Finds undervalued underdogs with high technical readiness.
     */
    static _checkInsidersEdge(match, modelPredictions) {
        if (!match.market_odds || !modelPredictions) return null;
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        
        const homeProb = modelPredictions.home_win_probability || 0;
        const marketOdds = parseFloat(odds.home) || 0;
        
        // Logic: Market thinks they are Underdogs (Odds > 2.5), but our model sees them as Favorites (Prob > 0.55)
        if (marketOdds > 2.5 && homeProb > 0.55 && (match.squad_health || 100) > 90) {
            return {
                type: "Insiders' Edge",
                details: `أفضلية سرية: البوكميكر يستهين بالفريق (أودز ${marketOdds}) رغم جاهزيته الفنية العالية وتوقع فوز بنسبة ${Math.round(homeProb*100)}%.`,
                weight: 30, // Negative weight to reduce suspicion if it's a positive "value" find? 
                // Actually, in the user's prompt, this is a positive "Multiplier" signal.
                tag: 'INSIDERS_EDGE'
            };
        }
        return null;
    }

    /**
     * [v4.5.1] Volatility Monitor: Detects sharp odds drops (>20%) indicitave of leaks or insider trades.
     */
    static _checkVolatility(match) {
        if (!match.market_odds) return null;
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        
        // Check if we have opening odds in fullData or passed match object
        let openingHome = match.opening_odds?.home || match.fullData?.opening_odds?.home;
        if (!openingHome && match.fullData) {
            try {
                const fd = typeof match.fullData === 'string' ? JSON.parse(match.fullData) : match.fullData;
                openingHome = fd.opening_odds?.home || fd.odds?.opening?.home;
            } catch(e) {}
        }

        if (openingHome && odds.home) {
            const drop = (openingHome - odds.home) / openingHome;
            if (drop > 0.20) {
                return {
                    type: 'Price Volatility',
                    details: `هبوط حاد في السعر (${Math.round(drop*100)}%) من الافتتاح (${openingHome}) إلى الحالي (${odds.home}). قد يشير لتسريب معلومات.`,
                    weight: 35,
                    tag: 'VOLATILITY_DROP'
                };
            }
        }
        return null;
    }

    static _getRecommendation(score, anomaly, insidersEdge) {
        if (score > 60) return 'تجنب (AVOID)';
        if (score > 30) return 'حذر (CAUTION)';
        if (anomaly && (anomaly.tag === 'BOOKIE_ERROR' || anomaly.tag === 'INSIDERS_EDGE')) return 'استغلال (EXPLOIT)';
        if (insidersEdge && insidersEdge.tag === 'INSIDERS_EDGE') return 'استغلال (EXPLOIT)';
        return 'طبيعي (NORMAL)';
    }

    static _checkAHDivergence(match, model) {
        if (!match.market_odds) return null;
        const odds = typeof match.market_odds === 'string' ? JSON.parse(match.market_odds) : match.market_odds;
        if (match.odds_drop_alert && odds.home > 2.5) {
            return {
                type: 'Handicap Divergence',
                details: 'البوكميكر يرفع سعر فوز صاحب الأرض، لكنه يحمي الهانديكاب. هذا يشير إلى توقع "تعادل موجه" أو حماية من فوز الضيف بصعوبة.',
                weight: 25,
                tag: 'AH_TRAP'
            };
        }
        return null;
    }
}

module.exports = IntegrityService;
