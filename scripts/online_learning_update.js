const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sqlite = require('better-sqlite3');

const logger = console;
const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');
const TRAIN_SCRIPT = path.join(__dirname, '..', 'core', 'train_v23_hybrid_ultra.py');

/**
 * Online Learning Update
 * Fetches the very latest archived matches and feeds them to the incremental_update function.
 */
async function runOnlineUpdate() {
    logger.info('🔄 [ONLINE-LEARNING] Checking for new data to update models...');

    try {
        const db = new sqlite(DB_PATH);
        // Get matches archived in the last 24 hours that haven't been 'learned' yet
        // In a real system, we'd track a 'last_learned_id'. For now, we take the last 50.
        const matches = db.prepare(`
            SELECT * FROM archive_matches 
            WHERE stats_blob IS NOT NULL 
            ORDER BY id DESC LIMIT 50
        `).all();

        if (matches.length === 0) {
            logger.info('✅ [ONLINE-LEARNING] No new data found for incremental update.');
            return;
        }

        logger.info(`📈 [ONLINE-LEARNING] Feeding ${matches.length} recent matches to V23 Hybrid hemisphers...`);

        // We use a temporary JSON to pass data to the Python incremental_update
        const tmpPath = path.join(__dirname, '..', 'data', 'online_batch.json');
        fs.writeFileSync(tmpPath, JSON.stringify(matches));

        const pythonScript = `
import json
import pandas as pd
import numpy as np
import sys
import os
sys.path.append(os.path.join(os.getcwd(), 'core'))
from train_v23_hybrid_ultra import incremental_update, FEATURE_NAMES
from ml_features import extract_ml_features

with open('${tmpPath.replace(/\\/g, '/')}', 'r') as f:
    matches = json.load(f)

data, labels = [], []
for row in matches:
    try:
        feats = extract_ml_features(row, fetch_history=False)
        data.append([feats.get(f, 0) for f in FEATURE_NAMES])
        hg, ag = row['scoreHome'], row['scoreAway']
        if hg > ag: labels.append(0)
        elif hg == ag: labels.append(1)
        else: labels.append(2)
    except: continue

if data:
    incremental_update(pd.DataFrame(data, columns=FEATURE_NAMES), np.array(labels))
    print("SUCCESS")
else:
    print("NO_DATA")
`;

        const pyProcess = spawn('python', ['-c', pythonScript], { 
            env: { ...process.env, PYTHONPATH: path.join(__dirname, '..', 'core') } 
        });

        pyProcess.stdout.on('data', (d) => logger.info(`[PYTHON-STDOUT] ${d.toString().trim()}`));
        pyProcess.stderr.on('data', (d) => logger.warn(`[PYTHON-STDERR] ${d.toString().trim()}`));

        pyProcess.on('close', (code) => {
            if (code === 0) {
                logger.info('✅ [ONLINE-LEARNING] Incremental update complete.');
            } else {
                logger.error(`❌ [ONLINE-LEARNING] Update failed with code ${code}`);
            }
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        });

    } catch (err) {
        logger.error('💥 [ONLINE-LEARNING] Error:', err.message);
    }
}

if (require.main === module) {
    runOnlineUpdate();
}

module.exports = { runOnlineUpdate };
