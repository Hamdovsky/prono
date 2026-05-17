const db = require('../core/database');
const { spawn } = require('child_process');
const path = require('path');

async function runTest() {
    try {
        console.log('--- 🩺 FULL SYSTEM DIAGNOSTICS (NODE BRIDGE) ---');
        const matches = await db.getMatchesByStatuses(['scheduled', 'live']);
        
        console.log(`[PASS] Matches found in DB: ${matches.length}`);
        if (matches.length === 0) {
            console.log('[WARN] No active matches to test.');
            return process.exit(0);
        }

        const match = matches[matches.length - 1]; // Test on the latest scheduled match
        console.log(`\n--- ⚽ PIPELINE TEST ON MATCH: ${match.homeTeam} vs ${match.awayTeam} ---`);

        const pythonPath = path.join(__dirname, 'core', 'python_worker.py');
        const py = spawn('python', [pythonPath]);

        let outputData = '';
        let errorData = '';

        py.stdout.on('data', (data) => { outputData += data.toString(); });
        py.stderr.on('data', (data) => { errorData += data.toString(); });

        py.on('close', (code) => {
            const lines = outputData.split('\n');
            let foundResult = false;
            
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const result = JSON.parse(line);
                    if (result.success && result.verdict) {
                        foundResult = true;
                        console.log('[PASS] Python worker returned successfully.');
                        console.log(`[PASS] Direct Prediction: ${result.direct_prediction || result.verdict}`);
                        
                        const taFeats = result.top_analyst_features || {};
                        const featCount = Object.keys(taFeats).length;
                        
                        if (featCount === 27) {
                            console.log(`[PASS] Top Analyst feature count: 27`);
                        } else {
                            console.log(`[FAIL] Top Analyst feature count expected 27, got: ${featCount}`);
                        }
                        
                        if (result.main_predictions) {
                             console.log(`[PASS] Main predictions formatted: ${result.main_predictions.length} items`);
                        }
                    }
                } catch (e) {
                    // Ignore non-JSON stdout lines
                }
            }
            
            if (!foundResult) {
                console.log('[FAIL] Could not parse a valid prediction result from Python stdout.');
                console.log('STDOUT:', outputData);
                console.log('STDERR:', errorData);
            }
            process.exit(code);
        });

        // Send payload and close stdin to signal python to start processing
        const payload = JSON.stringify({ action: 'predict', match: match }) + '\n';
        py.stdin.write(payload);
        py.stdin.end();

    } catch (e) {
        console.error('[FAIL] Test script crashed:', e);
        process.exit(1);
    }
}

runTest();
