const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

const dbPath = path.join(__dirname, '..', 'data', 'tactical.db');
const db = new Database(dbPath);

async function repredictToday() {
    console.log("🔄 Re-predicting today's matches with V100 Surgical logic...");
    
    const matches = db.prepare(`
        SELECT * FROM matches 
        WHERE date(datetime(startTimestamp, 'unixepoch')) >= date('now')
        AND date(datetime(startTimestamp, 'unixepoch')) <= date('now', '+1 day')
        LIMIT 50
    `).all();

    console.log(`Found ${matches.length} matches to process.`);

    for (const match of matches) {
        try {
            console.log(`Processing: ${match.homeTeam} vs ${match.awayTeam}`);
            const response = await axios.post('http://127.0.0.1:8000/predict', match, { timeout: 10000 });
            const result = response.data;
            
            if (result.success) {
                const update = db.prepare(`
                    UPDATE matches 
                    SET verdict = ?, 
                        confidence = ?, 
                        xgboost_confidence = ?, 
                        home_win_probability = ?,
                        draw_probability = ?,
                        away_win_probability = ?,
                        main_predictions = ?,
                        detailed_analysis = ?
                    WHERE id = ?
                `);
                
                update.run(
                    result.verdict,
                    result.xgboost_confidence * 100,
                    result.xgboost_confidence,
                    result.home_win_probability,
                    result.draw_probability,
                    result.away_win_probability,
                    JSON.stringify(result.main_predictions),
                    JSON.stringify(result.detailed_analysis),
                    match.id
                );
                console.log(`  ✅ Result: ${result.verdict} (${Math.round(result.xgboost_confidence * 100)}%)`);
            }
        } catch (e) {
            console.error(`  ❌ Error processing ${match.homeTeam}: ${e.message}`);
        }
    }
    
    console.log("Done!");
    db.close();
}

repredictToday();
