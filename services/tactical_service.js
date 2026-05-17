const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const { pooledConfig } = require('../core/networkConfig');

class TacticalService {
    /**
     * Run the Deep Tactical Audit for a match.
     * Uses the persistent AI server for 10x speedup.
     * 
     * @param {object} matchData { id, homeTeam, awayTeam, league, teamStats, odds }
     * @returns {Promise<object>} Tactical report result
     */
    static async auditMatch(matchData) {
        // 🚀 [TITANIUM GATEWAY] Connect to unified Port 3001 (Node API Gateway)
        let attempts = 0;
        const maxAttempts = 2;
        
        while (attempts < maxAttempts) {
            try {
                // Point to the dedicated /api/predict endpoint we just exposed
                const response = await axios.post('http://127.0.0.1:3001/api/predict', matchData, {
                    ...pooledConfig,
                    timeout: 90000, // 90s for heavy JIT batches / queue wait
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.API_SECRET_KEY || 'Matrix22!'}`
                    }
                });
                if (response.data && response.data.success !== false) {
                    return response.data;
                }
                break; // If success: false, stop retrying and fall back
            } catch (serverErr) {
                attempts++;
                const isTimeout = serverErr.code === 'ECONNABORTED' || serverErr.message.includes('timeout');
                
                if (attempts >= maxAttempts) {
                    if (!this._warned) {
                        const reason = isTimeout ? 'Timeout' : serverErr.message;
                        console.warn(`⚠️ [TACTICAL] Gateway (3001) unreachable after ${maxAttempts} attempts: ${reason}. Falling back to process spawn.`);
                        this._warned = true;
                    }
                } else {
                    // Short delay before retry
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }

        // 🏛️ [LEGACY FALLBACK] Slow but reliable process spawning
        return new Promise((resolve) => {
            const scriptPath = path.join(__dirname, '../core/tactical_lab_engine.py');
            
            let py;
            try {
                py = spawn('python', [scriptPath], {
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
                    windowsHide: true
                });
            } catch (spawnErr) {
                return resolve({ success: false, error: 'Python spawn failed', details: spawnErr.message });
            }

            if (!py || !py.stdin) {
                return resolve({ success: false, error: 'Python process unavailable' });
            }

            let output = '';
            let errorOutput = '';

            py.stdout.on('data', (d) => output += d.toString('utf8'));
            py.stderr.on('data', (d) => errorOutput += d.toString('utf8'));

            py.on('error', (err) => {
                resolve({ success: false, error: 'Python spawn error', details: err.message });
            });

            py.on('close', (code) => {
                if (code !== 0) {
                    return resolve({ success: false, error: 'Engine crash', details: errorOutput });
                }
                try {
                    const jsonStart = output.indexOf('{');
                    const clean = jsonStart >= 0 ? output.slice(jsonStart) : output;
                    const result = JSON.parse(clean);
                    resolve(result);
                } catch (e) {
                    resolve({ success: false, error: 'Parse Error', raw: output });
                }
            });

            try {
                py.stdin.write(JSON.stringify(matchData));
                py.stdin.end();
            } catch (writeErr) {
                resolve({ success: false, error: 'stdin write error', details: writeErr.message });
            }
        });
    }
}

TacticalService._warned = false;

module.exports = TacticalService;
