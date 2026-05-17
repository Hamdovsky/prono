const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const logger = console; // Simple logger for worker
const MODEL_PATH = path.join(__dirname, '..', 'models', 'stitch_v24_hybrid.json');
const TRAIN_SCRIPT = path.join(__dirname, '..', 'core', 'train_v24_top_analyst.py');

/**
 * Runs the Automated XGBoost Retraining Pipeline.
 * @returns {Promise<object>} Returns an object with the status and log output
 */
function runAutoRetrain() {
    return new Promise((resolve, reject) => {
        logger.info(`[AUTO-RETRAIN] Initiating V24 Top Analyst Retraining Pipeline...`);
        logger.info(`[AUTO-RETRAIN] Script: ${TRAIN_SCRIPT}`);

        let reportMsg = "⚙️ <b>Auto-Retrain Process Log</b>\n";

        // Store file modified time before run
        let oldModTime = 0;
        if (fs.existsSync(MODEL_PATH)) {
            oldModTime = fs.statSync(MODEL_PATH).mtimeMs;
        }

        let pythonPath = 'python';
        // Check for venv python
        const venvPythonPath = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
        if (fs.existsSync(venvPythonPath)) {
            pythonPath = venvPythonPath;
        }
        
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };

        const pythonProcess = spawn(pythonPath, [TRAIN_SCRIPT], { env, windowsHide: true });

        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString();
            if (output.includes('Accuracy') || output.includes('Log Loss') || output.includes('[!]')) {
                logger.info(`[AI-METRICS] ${output.trim()}`);
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            logger.warn(`[PYTHON-WARN] ${data.toString().trim()}`);
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                logger.error(`❌ [AUTO-RETRAIN] Pipeline failed with exit code ${code}`);
                return reject(`❌ Retrain Pipeline failed with exit code ${code}`);
            }

            logger.info(`✅ [AUTO-RETRAIN] Retraining process finished smoothly.`);

            if (fs.existsSync(MODEL_PATH)) {
                const newModTime = fs.statSync(MODEL_PATH).mtimeMs;
                if (newModTime > oldModTime) {
                    logger.info(`🧬 [V19-DUEL] Model updated. Starting Model Duel (Backtest Validation)...`);
                    
                    const AUDIT_SCRIPT = path.join(__dirname, 'audit_performance.py');
                    const auditProcess = spawn(pythonPath, [AUDIT_SCRIPT, '--last', '50'], { env, windowsHide: true });
                    
                    let auditOutput = '';
                    auditProcess.stdout.on('data', d => auditOutput += d.toString());
                    
                    auditProcess.on('close', (auditCode) => {
                        logger.info(`📊 [V19-RESULTS] Performance Audit:\n${auditOutput.trim()}`);
                        
                        let outcome = '';
                        if (auditOutput.includes('IMPROVEMENT') || auditOutput.includes('STABLE')) {
                            outcome = `🏆 <b>SUCCESS:</b> New model validated and deployed.`;
                            logger.info(outcome);
                        } else if (auditOutput.includes('REGRESSION')) {
                            outcome = `⚠️ <b>WARNING:</b> Model regression detected. Monitoring active.`;
                            logger.warn(outcome);
                        } else {
                            outcome = `✅ Model updated successfully.`;
                        }
                        
                        reportMsg += `${outcome}\n🔄 Prediction Engine is now using the newly trained model.`;
                        resolve({ success: true, message: reportMsg });
                    });
                } else {
                    const msg = `⚠️ Model file timestamp didn't change. Evaluation possibly skipped.`;
                    logger.warn(msg);
                    resolve({ success: false, message: msg });
                }
            } else {
                const msg = `❌ CRITICAL: Expected model file not found at ${MODEL_PATH}`;
                logger.error(msg);
                reject(msg);
            }
        });
    });
}

// Execute normally if run directly from terminal/cron
if (require.main === module) {
    runAutoRetrain()
        .then(res => {
            if (res.success) {
                const botService = require('../services/botService');
                botService.sendAlert(`🔥 <b>TITANIUM AUTO-RETRAIN</b> 🔥\n\n${res.message}`);
                // Wait briefly for telegram to send
                setTimeout(() => process.exit(0), 1000);
            } else {
                process.exit(1);
            }
        })
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}

module.exports = { runAutoRetrain };
