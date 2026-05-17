const database = require('./database');

async function runPythonPrediction(match) {
    try {
        // [MICROSERVICES] Call the standalone AI Prediction Service (FastAPI)
        const response = await fetch('http://127.0.0.1:8000/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(match)
        });

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status} - ${response.statusText}` };
        }
        return await response.json();
    } catch (e) {
        return { success: false, error: 'Network Error: ' + e.message + '. Is ai_server.py running?' };
    }
}

async function populatePredictions() {
    console.log("🚀 Starting Microservice Prediction Population Engine...");

    try {
        // Find scheduled matches that need processing (Now fully async PG via wrapper)
        const matches = await database.prepare(`
            SELECT * FROM matches 
            WHERE status IN ('scheduled', 'PRE_MATCH') 
            AND (home_win_probability = 0 OR xgboost_confidence = 0 OR home_win_probability IS NULL OR xgboost_confidence IS NULL)
        `).all();

        console.log(`📡 Found ${matches.length} matches to process.`);

        for (const row of matches) {
            console.log(`⏳ Processing: ${row.homeTeam || row.hometeam} vs ${row.awayTeam || row.awayteam}...`);

            try {
                // Determine fulldata mapping appropriately for PG casing (fullData vs fulldata)
                const rawFullData = row.fullData || row.fulldata;
                const matchInput = {
                    ...row,
                    fullData: typeof rawFullData === 'string' ? JSON.parse(rawFullData) : rawFullData
                };

                const result = await runPythonPrediction(matchInput);

                if (result.success && result.predictions) {
                    const winProbStat = result.predictions.find(p => p.label === '🏆 Win Prob');
                    const winRaw = winProbStat?.raw || { home: 33.3, draw: 33.4, away: 33.3 };

                    const scoreStat = result.predictions.find(p => p.label.includes('Score'));
                    const expectedScore = scoreStat?.label.replace('⚽ Score', '').trim() || '? - ?';

                    const chaosStat = result.predictions.find(p => p.label.includes('Chaos'));
                    const chaosMatch = chaosStat?.label.match(/Chaos\s+(\d+)%/);
                    const chaosScore = chaosMatch ? parseInt(chaosMatch[1], 10) : 50;

                    // Execute PG UPDATE using wrapped stmt
                    await database.prepare(`
                        UPDATE matches SET 
                            home_win_probability = ?,
                            draw_probability = ?,
                            away_win_probability = ?,
                            expected_score = ?,
                            chaos_score = ?,
                            xgboost_confidence = ?,
                            ou_25_prob = ?,
                            btts_prob = ?
                        WHERE id = ?
                    `).run(
                        winRaw.home, 
                        winRaw.draw, 
                        winRaw.away, 
                        expectedScore, 
                        chaosScore, 
                        result.xgboost_confidence || 0.5,
                        result.ou_25_prob || 0.5,
                        result.btts_prob || 0.5,
                        row.id
                    );

                    console.log(`✅ Updated ${row.homeTeam}: ${winRaw.home}% / ${winRaw.draw}% / ${winRaw.away}% [Conf: ${Math.round((result.xgboost_confidence||0.5)*100)}%]`);
                } else {
                    console.warn(`⚠️ Failed to predict ${row.homeTeam} vs ${row.awayTeam}: ${result.error || 'Unknown error'}`);
                }
            } catch (err) {
                console.error(`❌ Error processing match ${row.id}:`, err.message);
            }
        }

        console.log("🎯 Prediction Population Complete.");
    } catch (e) {
        console.error("❌ Fatal Engine Error:", e.message);
    }
}

if (require.main === module) {
    populatePredictions().catch(console.error);
}

module.exports = { populatePredictions, runPythonPrediction };
