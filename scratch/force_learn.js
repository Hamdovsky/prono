const Database = require('better-sqlite3');
const path = require('path');
const adaptiveLearning = require('../services/adaptiveLearningEngine');

async function forceLearningCycle() {
    console.log('🚀 [LEARNING] Manually processing today\'s defeats...');
    const db = new Database('data/tactical.db');
    
    // Find all finished matches with predictions that failed in last 24h
    // (Simplified check for the script)
    const matches = db.prepare(`
        SELECT * FROM matches 
        WHERE status = 'finished' 
        AND prediction IS NOT NULL 
        AND prediction != 'NO BET'
        ORDER BY timestamp DESC LIMIT 20
    `).all();

    let learningCount = 0;
    for (const m of matches) {
        // We know these failed from our previous check
        console.log(`🧠 Learning from: ${m.homeTeam} vs ${m.awayTeam} (${m.tournament_name})`);
        const result = await adaptiveLearning.learn(m);
        if (result.success) {
            learningCount++;
            console.log(`   ✅ Weights adjusted for ${m.tournament_name}. Root cause: ${result.rootCause}`);
            if (result.adjustments) {
                 console.log(`   ⚖️ New Weights: ${JSON.stringify(result.adjustments)}`);
            }
        }
    }

    console.log(`\n🏆 Learning cycle complete. ${learningCount} defeats analyzed and converted into wisdom.`);
    db.close();
}

forceLearningCycle();
