/**
 * V41 ALPHA HISTORICAL BACKTEST SERVICE - REFINED
 */
const database = require('../core/database');
const liveLabService = require('./liveLabService');

class BacktestService {
    async runHistoricalBacktest(limit = 500, period = 'all') {
        try {
            console.log(`🧪 [BACKTEST] Analyzing archived matches (Limit: ${limit}, Period: ${period})...`);
            
            let query = `
                SELECT * FROM matches 
                WHERE status IN ('FT', 'Finished', 'finished', 'FINISHED')
                AND fullData IS NOT NULL
            `;

            if (period === '1m') query += " AND timestamp > date('now', '-1 month')";
            else if (period === '3m') query += " AND timestamp > date('now', '-3 months')";
            else if (period === '1y') query += " AND timestamp > date('now', '-1 year')";

            query += " ORDER BY timestamp DESC LIMIT ?";
            
            const matches = await database.prepare(query).all(limit);

            if (matches.length === 0) return { error: 'لا توجد مباريات تاريخية كافية للفحص.' };

            let correct1X2 = 0;
            let correctGoals = 0;
            let eliteSignals = 0;
            let eliteCorrect = 0;
            let totalMatchTests = 0;
            let simulatedROI = 0;

            for (const m of matches) {
                totalMatchTests++;
                
                try {
                    const fullData = JSON.parse(m.fullData);
                    let pronos = [];
                    
                    if (fullData.enriched && fullData.enriched.main_predictions) {
                        pronos = fullData.enriched.main_predictions;
                    } else if (fullData.predictions) {
                        pronos = fullData.predictions;
                    }

                    const scoreH = parseInt(m.scoreHome) || 0;
                    const scoreA = parseInt(m.scoreAway) || 0;
                    const totalGoals = scoreH + scoreA;
                    const actualWinner = scoreH > scoreA ? 'H' : scoreH < scoreA ? 'A' : 'D';

                    pronos.forEach(p => {
                        let isCorrect = false;

                        // Identify Market Type
                        const label = p.label || p.type || '';
                        const val = p.val || p.market || '';
                        
                        const is1X2 = label.includes('Winner') || label.includes('1X2') || label.includes('Choix');
                        const isGoals = label.includes('Goals') || label.includes('الأهداف') || label.includes('O/U');

                        if (is1X2) {
                            const isHomePred = val.includes(m.homeTeam) || val.includes('🏠') || val.includes('domicile');
                            const isAwayPred = val.includes(m.awayTeam) || val.includes('✈️') || val.includes('extérieur');
                            const predictedSide = isHomePred ? 'H' : isAwayPred ? 'A' : 'D';
                            if (predictedSide === actualWinner) isCorrect = true;
                            if (isCorrect) correct1X2++;
                        }

                        if (isGoals) {
                            const targetStr = val.match(/[\d\.]+/);
                            const target = targetStr ? parseFloat(targetStr[0]) : 2.5;
                            const isOver = val.toLowerCase().includes('over') || val.includes('أكثر') || val.includes('+');
                            
                            if (isOver && totalGoals > target) isCorrect = true;
                            if (!isOver && totalGoals < target) isCorrect = true;
                            if (isCorrect) correctGoals++;
                        }

                        const isElite = (p.confidence && p.confidence >= 80) || val.includes('🔥') || fullData.verdict === 'SAFE BET';
                        if (isElite) {
                            eliteSignals++;
                            if (isCorrect) eliteCorrect++;
                        }

                        // Simulated ROI logic (simple flat betting unit assumption ~ odds 1.85)
                        if (isCorrect) simulatedROI += 0.85; else simulatedROI -= 1;
                    });
                } catch (e) {
                    // Ignore parse errors on corrupted older records
                }
            }

            const summary = {
                totalMatches: totalMatchTests,
                totalPredictions: eliteSignals, 
                accuracy1X2: totalMatchTests > 0 ? Math.round((correct1X2 / totalMatchTests) * 100) : 0,
                accuracyGoals: totalMatchTests > 0 ? Math.round((correctGoals / totalMatchTests) * 100) : 0,
                eliteAccuracy: eliteSignals > 0 ? Math.round((eliteCorrect / eliteSignals) * 100) : 0,
                roi: Math.round(simulatedROI),
                rating: eliteSignals > 0 ? (eliteCorrect / eliteSignals * 10).toFixed(1) : 0
            };

            return {
                summary,
                insights: [
                    `فحص ${totalMatchTests} مباراة تاريخية.`,
                    summary.eliteAccuracy > 60 
                        ? `إشارات السوق (Elite) حققت كفاءة ممتازة بنسبة ${summary.eliteAccuracy}%.` 
                        : `التوقعات العالية الثقة حققت نسبة ${summary.eliteAccuracy}%.`,
                    `النظام يظهر تفوقاً في سوق ${summary.accuracy1X2 > summary.accuracyGoals ? 'نسبة الفوز (1X2)' : 'الأهداف (O/U)'}.`
                ]
            };
        } catch (err) {
            console.error('[Backtest] Critical Error:', err);
            return { error: 'حدث خطأ أثناء المحاكاة.' };
        }
    }
}

module.exports = new BacktestService();
