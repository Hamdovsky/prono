const Database = require('better-sqlite3');
const path = require('path');
const StatisticalEngine = require('../core/services/StatisticalEngine');
const QuantumQuantEngine = require('../core/QuantumQuantEngine');

const ARCHIVE_DB_PATH = path.resolve(__dirname, '../data/historical_archive.sqlite');
const db = new Database(ARCHIVE_DB_PATH, { readonly: true });

function analyze() {
    console.log('📊 [PERFORMANCE AUDIT] Backtesting Engine JS sur Archive Historique...');
    
    const matches = db.prepare(`
        SELECT 
            id, homeTeam, awayTeam, 
            scoreHome, scoreAway, 
            home_xg, away_xg, 
            tournament_name
        FROM archive_matches 
        WHERE scoreHome IS NOT NULL 
        AND scoreAway IS NOT NULL
        LIMIT 500
    `).all();

    if (matches.length === 0) {
        console.log('❌ Aucun match trouvé dans l\'archive.');
        return;
    }

    let total = matches.length;
    let winH_correct = 0;
    let winA_correct = 0;
    let draw_correct = 0;
    let exactScore_correct = 0;
    let btts_correct = 0;
    let ou25_correct = 0;

    matches.forEach(m => {
        // Mock match object for the engine
        const matchObj = {
            ...m,
            home_win_probability: 0, // Force engine to recalculate
            draw_probability: 0,
            away_win_probability: 0,
            btts_prob: 0,
            ou_25_prob: 0
        };

        // 1. Get xG from engine (using the match's stored xG)
        const { h: xgH, a: xgA } = StatisticalEngine.getMatchXG(matchObj);
        
        // 2. Run Quantum Analysis
        const quant = QuantumQuantEngine.analyze(matchObj, xgH, xgA);

        const h = m.scoreHome;
        const a = m.scoreAway;
        const totalGoals = h + a;
        const isBtts = (h > 0 && a > 0);
        const isOver25 = totalGoals >= 3;

        // 3. Validate Main Pick
        const hProb = quant.markets.match_result['1'].prob;
        const aProb = quant.markets.match_result['2'].prob;
        const dProb = quant.markets.match_result['X'].prob;

        if (hProb > aProb && hProb > dProb) {
            if (h > a) winH_correct++;
        } else if (aProb > hProb && aProb > dProb) {
            if (a > h) winA_correct++;
        } else {
            if (h === a) draw_correct++;
        }

        // 4. Validate Exact Score
        if (quant.expected_score) {
            const [expH, expA] = quant.expected_score.split(/\s*-\s*/).map(s => parseInt(s.trim()));
            if (expH === h && expA === a) exactScore_correct++;
        }

        // 5. Validate BTTS
        const bttsProb = quant.probs.btts;
        if ((bttsProb >= 0.5 && isBtts) || (bttsProb < 0.5 && !isBtts)) {
            btts_correct++;
        }

        // 6. Validate O/U 2.5
        const ouProb = quant.probs.over25;
        if ((ouProb >= 0.5 && isOver25) || (ouProb < 0.5 && !isOver25)) {
            ou25_correct++;
        }
    });

    console.log(`\n--- RÉSULTATS DU BACKTEST (n=${total}) ---`);
    console.log(`✅ Main Pick (1X2) : ${(((winH_correct + winA_correct + draw_correct) / total) * 100).toFixed(1)}%`);
    console.log(`🎯 Score Exact : ${((exactScore_correct / total) * 100).toFixed(1)}%`);
    console.log(`⚽ BTTS Accuracy : ${((btts_correct / total) * 100).toFixed(1)}%`);
    console.log(`📈 Over/Under 2.5 : ${((ou25_correct / total) * 100).toFixed(1)}%`);
    console.log(`----------------------------------------\n`);
}

analyze();
db.close();
