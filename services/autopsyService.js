/**
 * V95 Post-Match Autopsy Engine
 * -----------------------------
 * Analyzes finished matches to determine WHY a prediction failed.
 * Root causes: Red Card Anomaly, xG Underperformance, Late Goal Heartbreak, GK Masterclass.
 */
const database = require('../core/database');

class AutopsyService {
    constructor() {
        this.LIMIT = 150; // Analyze last 150 matches
    }

    async diagnoseMatch(matchId) {
        try {
            const m = await database.db.prepare(`SELECT * FROM matches WHERE id = ?`).get(matchId);
            if (!m || !m.fullData) return null;
            
            const fullData = JSON.parse(m.fullData);
            const scoreH = parseInt(m.scoreHome) || 0;
            const scoreA = parseInt(m.scoreAway) || 0;
            const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';
            
            // Assume first prediction for diagnosis context
            const prono = (fullData.enriched && fullData.enriched.main_predictions) ? fullData.enriched.main_predictions[0] : null;
            
            return this._diagnoseFailure(m, fullData, scoreH, scoreA, actualWinner, prono);
        } catch (_) { return null; }
    }

    async generateAutopsyReport() {
        try {
            console.log('🔬 [AUTOPSY] Running post-match autopsy analyzer...');
            
            const query = `
                SELECT * FROM matches 
                WHERE status IN ('FT', 'Finished', 'finished', 'FINISHED')
                AND fullData IS NOT NULL
                ORDER BY timestamp DESC LIMIT ?
            `;
            const matches = await database.prepare(query).all(this.LIMIT);
            
            const failedMatches = [];

            for (const m of matches) {
                try {
                    const fullData = JSON.parse(m.fullData);
                    let pronos = (fullData.enriched && fullData.enriched.main_predictions) 
                        ? fullData.enriched.main_predictions 
                        : (fullData.predictions || []);

                    // Fallback to row probabilities if predictions array is missing
                    if (pronos.length === 0) {
                        const h = parseFloat(m.home_win_probability || fullData.home_win_probability || 0);
                        const d = parseFloat(m.draw_probability || fullData.draw_probability || 0);
                        const a = parseFloat(m.away_win_probability || fullData.away_win_probability || 0);
                        
                        if (h > 0 || d > 0 || a > 0) {
                            let predVal = 'DRAW';
                            if (h >= d && h > a) predVal = m.homeTeam;
                            if (a >= d && a > h) predVal = m.awayTeam;
                            
                            const maxProb = Math.max(h, d, a);
                            pronos = [{
                                label: 'Winner',
                                val: predVal,
                                probability: maxProb,
                                confidence: m.xgboost_confidence || fullData.xgboost_confidence || maxProb
                            }];
                        } else {
                            // FINAL FALLBACK: Assume Home Favorite if completely empty (System Recovery Mode)
                            pronos = [{
                                label: 'Winner',
                                val: m.homeTeam,
                                probability: 65,
                                confidence: 75
                            }];
                        }
                    }

                    if (pronos.length === 0) continue;

                    const scoreH = parseInt(m.scoreHome) || 0;
                    const scoreA = parseInt(m.scoreAway) || 0;
                    const totalGoals = scoreH + scoreA;
                    const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';

                    let isCorrect = this._checkIfPredictionCorrect(pronos, m, actualWinner, totalGoals);
                    
                    if (!isCorrect) {
                        // Prediction Failed: Run Autopsy
                        const diagnosisData = this._diagnoseFailure(m, fullData, scoreH, scoreA, actualWinner, pronos[0]);
                        
                        failedMatches.push({
                            id: m.id,
                            homeTeam: m.homeTeam,
                            awayTeam: m.awayTeam,
                            score: `${scoreH} - ${scoreA}`,
                            prediction: pronos[0] ? (pronos[0].label + ' / ' + pronos[0].val) : 'N/A',
                            confidence: pronos[0]?.probability || pronos[0]?.confidence || (fullData.xgboost_confidence ? Math.round(fullData.xgboost_confidence * 100) : 'N/A'),
                            autopsy: diagnosisData.diagnosis,
                            surgicalStats: diagnosisData.stats,
                            criticalIncidents: diagnosisData.incidents
                        });
                    }
                } catch (e) {
                    // Skip corrupted blobs
                    continue;
                }
            }

            console.log(`🔬 [AUTOPSY] Found ${failedMatches.length} failed predictions out of ${matches.length} matches.`);
            
            // Auto-persist and notify
            for (const failed of failedMatches) {
                await this.saveAutopsy(failed.id, failed);
                if (failed.confidence >= 75) {
                    await this.notifyHeartbreak(failed);
                }
            }

            return {
                status: 'success',
                analyzedCount: matches.length,
                failedCount: failedMatches.length,
                report: failedMatches
            };

        } catch (error) {
            console.error('🔬 [AUTOPSY] Fatal error:', error);
            return { status: 'error', message: error.message };
        }
    }

    async saveAutopsy(matchId, result) {
        try {
            await database.prepare(`
                UPDATE matches 
                SET autopsy_result = ?, is_autopsied = 1 
                WHERE id = ?
            `).run(JSON.stringify(result), matchId);
        } catch (e) {
            console.error(`❌ [AUTOPSY] DB Save error: ${e.message}`);
        }
    }

    async notifyHeartbreak(failed) {
        const botService = require('./botService');
        const msg = `💔 <b>AUTOPSIE : DÉFAITE SURGICAL</b>\n` +
                    `⚠️ Match: <b>${failed.homeTeam} vs ${failed.awayTeam}</b>\n` +
                    `📊 Score: <b>${failed.score}</b>\n` +
                    `🎯 Prono: <b>${failed.prediction}</b> (Conf: ${failed.confidence}%)\n\n` +
                    `🔬 <b>RAISON :</b> ${failed.autopsy ? (failed.autopsy.ar || failed.autopsy) : 'ANOMALIE NON DÉFINIE'}\n\n` +
                    `🤖 <i>L'IA a identifié cet échec comme une anomalie ${failed.autopsy?.type || 'imprévisible'}.</i>`;
        
        await botService._executeSend(msg, process.env.TELEGRAM_CHAT_ID);
    }

    _checkIfPredictionCorrect(pronos, match, actualWinner, totalGoals) {
        let anyCorrect = false;
        pronos.forEach(p => {
            const label = p.label || p.type || '';
            const val = p.val || p.market || '';
            
            const is1X2 = label.includes('Winner') || label.includes('1X2') || label.includes('Choix') || label.includes('Analyst') || label.includes('Favori');
            const isGoals = label.includes('Goals') || label.includes('الأهداف') || label.includes('O/U') || label.includes('Buts');

            if (is1X2) {
                const homeLower = (match.homeTeam || '').toLowerCase();
                const awayLower = (match.awayTeam || '').toLowerCase();
                const valLower = val.toLowerCase();

                const isHomePred = valLower.includes(homeLower) || val.includes('🏠') || val.includes('Home') || val.includes('1');
                const isAwayPred = valLower.includes(awayLower) || val.includes('✈️') || val.includes('Away') || val.includes('2');
                const isDrawPred = valLower.includes('draw') || val.includes('x') || val.includes('تعادل');

                const predictedSide = isHomePred ? 'H' : isAwayPred ? 'A' : (isDrawPred ? 'D' : null);
                
                if (predictedSide && predictedSide === actualWinner) anyCorrect = true;
                
                // Special case for Double Chance
                if (label.includes('Double') || label.includes('فرصة')) {
                   if (val.includes('1X') && (actualWinner === 'H' || actualWinner === 'D')) anyCorrect = true;
                   if (val.includes('X2') && (actualWinner === 'A' || actualWinner === 'D')) anyCorrect = true;
                   if (val.includes('12') && (actualWinner === 'H' || actualWinner === 'A')) anyCorrect = true;
                }
            }

            if (isGoals) {
                const targetStr = val.match(/[\d\.]+/);
                const target = targetStr ? parseFloat(targetStr[0]) : 2.5;
                const isOver = val.toLowerCase().includes('over') || val.includes('أكثر') || val.includes('+');
                
                if (isOver && totalGoals > target) anyCorrect = true;
                if (!isOver && totalGoals < target) anyCorrect = true;
            }
        });
        return anyCorrect;
    }

    _normalizeStats(rawStats) {
        const normalized = {
            redCards: { home: 0, away: 0 },
            expectedGoals: { home: 0, away: 0 },
            shotsOnTarget: { home: 0, away: 0 },
            bigChances: { home: 0, away: 0 },
            possession: { home: 50, away: 50 },
            totalShots: { home: 0, away: 0 },
            corners: { home: 0, away: 0 }
        };

        if (!rawStats) return normalized;

        const processItem = (item) => {
            const cat = (item.name || item.category || '').toLowerCase();
            const h = parseFloat(item.homeValue || item.home) || 0;
            const a = parseFloat(item.awayValue || item.away) || 0;

            if (cat.includes('red card')) { normalized.redCards.home = h; normalized.redCards.away = a; }
            if (cat.includes('expected goal')) { normalized.expectedGoals.home = h; normalized.expectedGoals.away = a; }
            if (cat.includes('shots on target')) { normalized.shotsOnTarget.home = h; normalized.shotsOnTarget.away = a; }
            if (cat.includes('big chance')) { normalized.bigChances.home = h; normalized.bigChances.away = a; }
            if (cat.includes('possession')) { normalized.possession.home = h; normalized.possession.away = a; }
            if (cat.includes('total shots') || cat === 'shots') { normalized.totalShots.home = h; normalized.totalShots.away = a; }
            if (cat.includes('corner')) { normalized.corners.home = h; normalized.corners.away = a; }
        };

        // Case 1: Raw SofaScore nested array (periods -> groups -> items)
        if (Array.isArray(rawStats) && rawStats[0]?.groups) {
            rawStats.forEach(period => {
                if (period.period === 'ALL' || period.period === 'Total') {
                    period.groups.forEach(group => {
                        group.statisticsItems.forEach(item => processItem(item));
                    });
                }
            });
            // If ALL was not found, try to use the first period as fallback
            if (normalized.totalShots.home === 0 && rawStats.length > 0) {
                 rawStats[0].groups.forEach(group => {
                    group.statisticsItems?.forEach(item => processItem(item));
                 });
            }
        }
        // Case 2: Flattened array (from our Extractor)
        else if (Array.isArray(rawStats)) {
            rawStats.forEach(item => processItem(item));
        } 
        // Case 3: Simple object
        else {
            normalized.redCards.home = rawStats.redCards?.home || 0;
            normalized.redCards.away = rawStats.redCards?.away || 0;
            normalized.expectedGoals.home = rawStats.expectedGoals?.home || 0;
            normalized.expectedGoals.away = rawStats.expectedGoals?.away || 0;
            normalized.shotsOnTarget.home = rawStats.shotsOnTarget?.home || 0;
            normalized.shotsOnTarget.away = rawStats.shotsOnTarget?.away || 0;
            normalized.possession.home = rawStats.possession?.home || 50;
            normalized.corners.home = rawStats.corners?.home || 0;
            normalized.corners.away = rawStats.corners?.away || 0;
        }

        return normalized;
    }

    _diagnoseFailure(matchRow, fullData, scoreH, scoreA, actualWinner, mainPrediction) {
        let diagnosis = { 
            ar: 'سبب تكتيكي غير واضح (خسارة طبيعية بسبب تقلبات المباريات).', 
            icon: '🤷‍♂️',
            type: 'UNKNOWN'
        };

        const stats = this._normalizeStats(fullData.stats);
        const incidents = fullData.incidents || [];
        
        let earlyGoalConcededH = false, earlyGoalConcededA = false;
        let penaltyConcededH = false, penaltyConcededA = false;
        let redCardBefore70H = false, redCardBefore70A = false;

        incidents.forEach(inc => {
            const t = parseInt(inc.time) || 0;
            const type = (inc.type || inc.incidentType || inc.incidentClass || '').toLowerCase();
            const text = (inc.text || '').toLowerCase();
            
            // Red Card Check
            if (type.includes('red') || text.includes('red card') || (type === 'card' && (inc.incidentClass === 'red' || inc.incidentClass === 'yellowRed'))) {
                // If it's home getting the card, isHome is true
                if (inc.isHome === true || inc.isHome === 'true') { if (t < 70) redCardBefore70H = true; }
                else if (inc.isHome === false || inc.isHome === 'false') { if (t < 70) redCardBefore70A = true; }
            }
            
            // Goal Check
            if (type === 'goal' || inc.incidentClass === 'regular' || inc.incidentClass === 'penalty') {
                const isPenalty = inc.incidentClass === 'penalty' || text.includes('penalty') || text.includes('جزاء');
                if (inc.isHome === true || inc.isHome === 'true') {
                    if (t <= 15) earlyGoalConcededA = true; // Home score = Away concede
                    if (isPenalty) penaltyConcededA = true; 
                } else if (inc.isHome === false || inc.isHome === 'false') {
                    if (t <= 15) earlyGoalConcededH = true; // Away score = Home concede
                    if (isPenalty) penaltyConcededH = true;
                }
            }
        });

        // Fallback for Red Cards if incidents are missing
        if (!redCardBefore70H && stats.redCards.home > 0 && incidents.length === 0) redCardBefore70H = true;
        if (!redCardBefore70A && stats.redCards.away > 0 && incidents.length === 0) redCardBefore70A = true;

        if (redCardBefore70H && scoreH < scoreA) {
            diagnosis = { ar: `خسر الفريق المضيف (${matchRow.homeTeam}) بسبب طرد مبكر (قبل الدقيقة 70) دمر الهيكل الدفاعي.`, icon: '🛑', type: 'PERSONNEL_DEFICIT_DISRUPTION' };
        } else if (redCardBefore70A && scoreA < scoreH) {
            diagnosis = { ar: `خسر الفريق الضيف (${matchRow.awayTeam}) بسبب طرد مبكر (قبل الدقيقة 70) دمر الخطة التكتيكية.`, icon: '🛑', type: 'PERSONNEL_DEFICIT_DISRUPTION' };
        }
        
        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 2. Early Goal (EARLY_TACTICAL_DISRUPTION)
        if (earlyGoalConcededH && scoreH < scoreA) {
            diagnosis = { ar: `هدف مبكر بعثر الأوراق التكتيكية للفريق المضيف في أول 15 دقيقة، ودفع الخصم للركون للدفاع.`, icon: '⏱️', type: 'EARLY_TACTICAL_DISRUPTION' };
        } else if (earlyGoalConcededA && scoreA < scoreH) {
            diagnosis = { ar: `هدف مبكر مباغت في أول 15 دقيقة دمر خطة لعب الفريق الضيف ولخبط الحسابات.`, icon: '⏱️', type: 'EARLY_TACTICAL_DISRUPTION' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 3. Penalty Disaster (SET_PIECE_DECIDER)
        if (penaltyConcededH && scoreH < scoreA && (scoreA - scoreH) === 1) {
            diagnosis = { ar: `ركلة جزاء فارقة منحت الأفضلية للخصم وحسمت المباراة بصعوبة للفريق الضيف.`, icon: '🎯', type: 'SET_PIECE_DECIDER' };
        } else if (penaltyConcededA && scoreA < scoreH && (scoreH - scoreA) === 1) {
            diagnosis = { ar: `ركلة جزاء فارقة منحت الأفضلية لصاحب الأرض وحسمت المباراة بصعوبة.`, icon: '🎯', type: 'SET_PIECE_DECIDER' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };
        
        // 4. Defensive Collapse (SYSTEMIC_DEFENSIVE_FAILURE)
        if (scoreH < scoreA && scoreA >= 3) {
            diagnosis = { ar: `انهيار دفاعي كارثي غير متوقع: تلقى الفريق المضيف ${scoreA} أهداف في شباكه.`, icon: '📉', type: 'SYSTEMIC_DEFENSIVE_FAILURE' };
        } else if (scoreA < scoreH && scoreH >= 3) {
            diagnosis = { ar: `انهيار دفاعي كارثي غير متوقع: تلقى الفريق الضيف ${scoreH} أهداف في شباكه.`, icon: '📉', type: 'SYSTEMIC_DEFENSIVE_FAILURE' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 5. Boring Stalemate (LOW_INTENSITY_OFFENSE)
        const totalGoals = scoreH + scoreA;
        if (actualWinner === 'D' && (totalGoals === 0 || totalGoals === 2) && stats.shotsOnTarget.home < 3 && stats.shotsOnTarget.away < 3) {
            diagnosis = { ar: `غياب تام للشراسة الهجومية وأداء باهت جداً (تسديدات نادرة من الطرفين وعقم هجومي واضح).`, icon: '🥱', type: 'LOW_INTENSITY_OFFENSE' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 6. xG Waste (0.85 threshold)
        const xgH = stats.expectedGoals.home;
        const xgA = stats.expectedGoals.away;
        if (xgH > xgA + 0.85 && scoreH <= scoreA) {
            diagnosis = { ar: `رعونة هجومية: ${matchRow.homeTeam} تفوق في الأهداف المتوقعة (xG: ${xgH.toFixed(2)}) ولكنه تفنن في الإهدار.`, icon: '🥅', type: 'XG_WASTE' };
        } else if (xgA > xgH + 0.85 && scoreA <= scoreH) {
            diagnosis = { ar: `رعونة هجومية: ${matchRow.awayTeam} تفوق في الأهداف المتوقعة (xG: ${xgA.toFixed(2)}) ولم يحولها إلى أهداف.`, icon: '🥅', type: 'XG_WASTE' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 7. GK Wall (SoT >= 4, Goals <= 1)
        if (stats.shotsOnTarget.home >= 4 && scoreH <= 1 && actualWinner !== 'H') {
            diagnosis = { ar: `تألق إعجازي لحارس مرمى الخصم الذي تصدى لتسديدات ${matchRow.homeTeam} الكثيرة وحرمه من الفوز.`, icon: '🧤', type: 'GK_WALL' };
        } else if (stats.shotsOnTarget.away >= 4 && scoreA <= 1 && actualWinner !== 'A') {
            diagnosis = { ar: `جدار دفاعي وتألق مبهر للحارس الخصم حرم ${matchRow.awayTeam} من التسجيل رغم كثرة التسديدات.`, icon: '🧤', type: 'GK_WALL' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 8. Big Chance Waste (>= 2)
        if (stats.bigChances.home >= 2 && scoreH < scoreA) {
             diagnosis = { ar: `إهدار فرص محققة: فريق ${matchRow.homeTeam} أضاع ${stats.bigChances.home} فرص مؤكدة للتسجيل كانت كفيلة بحسم اللقاء.`, icon: '🚫', type: 'BIG_CHANCE_WASTE' };
        } else if (stats.bigChances.away >= 2 && scoreA < scoreH) {
             diagnosis = { ar: `إهدار فرص محققة: فريق ${matchRow.awayTeam} أضاع ${stats.bigChances.away} فرص مؤكدة للتسجيل أمام المرمى.`, icon: '🚫', type: 'BIG_CHANCE_WASTE' };
        }
        
        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };
        
        // 9. Shot Dominance (+6)
        if (stats.totalShots.home > stats.totalShots.away + 6 && scoreH <= scoreA) {
             diagnosis = { ar: `سيطرة ميدانية عقيمة: ${matchRow.homeTeam} سدد أكثر من الخصم بكثير، لكنه فشل في الحسم.`, icon: '🏹', type: 'SHOT_DOMINANCE' };
        } else if (stats.totalShots.away > stats.totalShots.home + 6 && scoreA <= scoreH) {
             diagnosis = { ar: `ضغط هجومي غير مستغل: ${matchRow.awayTeam} سدد أكثر من المنافس ومع ذلك خسر اللقاء.`, icon: '🏹', type: 'SHOT_DOMINANCE' };
        }
        
        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };
        
        // 10. Corner Dominance (+7)
        if (stats.corners.home > stats.corners.away + 7 && scoreH <= scoreA) {
             diagnosis = { ar: `حصار هجومي فاشل: تفوق ${matchRow.homeTeam} الكبير في الركنيات يوضح سيطرته العقيمة.`, icon: '🚩', type: 'CORNER_DOMINANCE' };
        } else if (stats.corners.away > stats.corners.home + 7 && scoreA <= scoreH) {
             diagnosis = { ar: `سيطرة كلية على الكرات الثابتة: ${matchRow.awayTeam} لم يستغل الركنيات لهز الشباك الخصم.`, icon: '🚩', type: 'CORNER_DOMINANCE' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };

        // 11. Late Goal (> 85 minute)
        const lateGoal = incidents.find(inc => (inc.type === 'goal' || inc.incidentClass === 'regular') && parseInt(inc.time) > 85);
        if (lateGoal) {
            diagnosis = { ar: `تحطم التوقع بسبب "هدف قاتل" في الدقيقة ${lateGoal.time} قلب موازين النتيجة بالكامل.`, icon: '⏱️', type: 'LATE_GOAL' };
        }

        if (diagnosis.type !== 'UNKNOWN') return { diagnosis, stats, incidents };
        
        // 12. Possession Dominance Fail (> 61%)
        if (stats.possession.home > 61 && scoreH < scoreA) {
            diagnosis = { ar: `استحواذ سلبي: ${matchRow.homeTeam} سيطر بنسبة ${stats.possession.home}% لكنه اُصيب بمرتدة قاتلة.`, icon: '🔄', type: 'POSSESSION_FAIL' };
        }

        return {
            diagnosis,
            stats,
            incidents: incidents.filter(i => ['goal', 'card', 'red', 'penalty'].some(t => (i.type || i.incidentClass || '').toLowerCase().includes(t)))
        };
    }
}

module.exports = new AutopsyService();
