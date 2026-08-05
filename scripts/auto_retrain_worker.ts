// @ts-nocheck
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

const logger = console // Simple logger for worker
const MODEL_PATH = path.join(__dirname, '..', 'models', 'stitch_v24_hybrid.json')
const TRAIN_SCRIPT = path.join(__dirname, '..', 'core', 'train_v24_top_analyst.py')

const LIVE_MODEL_PATH = path.join(__dirname, '..', 'models', 'live_goal_xgb.json')
const LIVE_TRAIN_SCRIPT = path.join(__dirname, '..', 'core', 'train_live_model.py')

const FEEDBACK_SCRIPT = path.join(__dirname, '..', 'scripts', 'backtest_feedback.py')
const CALIBRATION_SCRIPT = path.join(__dirname, '..', 'core', 'backtest_feedback.py')

function _findPython() {
  let pythonPath = 'python'
  const venvPythonPath = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(venvPythonPath)) {
    pythonPath = venvPythonPath
  }
  return pythonPath
}

/**
 * Run backtest_feedback.py to generate per-league training weights.
 * This bridges JS settlement data → Python XGBoost retraining.
 */
function runBacktestFeedback() {
  return new Promise((resolve) => {
    logger.info('[FEEDBACK] Running backtest feedback to generate training weights...')
    const pythonPath = _findPython()
    const proc = spawn(pythonPath, [FEEDBACK_SCRIPT], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    })
    let stdout = ''
    proc.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      logger.info(`[FEEDBACK] ${s.trim()}`)
    })
    proc.stderr.on('data', (d) => logger.warn(`[FEEDBACK-WARN] ${d.toString().trim()}`))
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info('[FEEDBACK] Training weights generated successfully')
        resolve(true)
      } else {
        logger.warn(
          `[FEEDBACK] Feedback script exited with code ${code} — continuing with existing weights`
        )
        resolve(false)
      }
    })
    proc.on('error', (e) => {
      logger.warn(`[FEEDBACK] Could not run feedback script: ${e.message}`)
      resolve(false)
    })
  })
}

/**
 * Run core/backtest_feedback.py to generate per-league calibration weights from Brier/LogLoss.
 */
function runCalibrationFeedback() {
  return new Promise((resolve) => {
    logger.info('[CALIBRATION] Running calibration feedback (Brier/LogLoss)...')
    const pythonPath = _findPython()
    const proc = spawn(pythonPath, [CALIBRATION_SCRIPT], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    })
    let stdout = ''
    proc.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      logger.info(`[CALIBRATION] ${s.trim()}`)
    })
    proc.stderr.on('data', (d) => logger.warn(`[CALIBRATION-WARN] ${d.toString().trim()}`))
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info('[CALIBRATION] Calibration weights generated successfully')
        resolve(true)
      } else {
        logger.warn(`[CALIBRATION] Calibration script exited with code ${code}`)
        resolve(false)
      }
    })
    proc.on('error', (e) => {
      logger.warn(`[CALIBRATION] Could not run calibration script: ${e.message}`)
      resolve(false)
    })
  })
}

/**
 * Runs the Automated XGBoost Retraining Pipeline.
 * @returns {Promise<object>} Returns an object with the status and log output
 */
function runAutoRetrain() {
  return new Promise(async (resolve, reject) => {
    logger.info(`[AUTO-RETRAIN] Initiating V24 Top Analyst Retraining Pipeline...`)
    logger.info(`[AUTO-RETRAIN] Script: ${TRAIN_SCRIPT}`)

    // Step 0: Generate backtest feedback weights
    await runBacktestFeedback()

    // Step 0.5: Generate calibration weights from Brier/LogLoss
    await runCalibrationFeedback()

    let reportMsg = '⚙️ <b>Auto-Retrain Process Log</b>\n'

    // Store file modified time before run
    let oldModTime = 0
    if (fs.existsSync(MODEL_PATH)) {
      oldModTime = fs.statSync(MODEL_PATH).mtimeMs
    }

    let pythonPath = 'python'
    // Check for venv python
    const venvPythonPath = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    if (fs.existsSync(venvPythonPath)) {
      pythonPath = venvPythonPath
    }

    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }

    const pythonProcess = spawn(pythonPath, [TRAIN_SCRIPT], { env, windowsHide: true })
    pythonProcess.on('error', (e) => logger.error(`[AUTO-RETRAIN] Spawn error: ${e.message}`))

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString()
      if (output.includes('Accuracy') || output.includes('Log Loss') || output.includes('[!]')) {
        logger.info(`[AI-METRICS] ${output.trim()}`)
      }
    })

    pythonProcess.stderr.on('data', (data) => {
      logger.warn(`[PYTHON-WARN] ${data.toString().trim()}`)
    })

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        logger.error(`❌ [AUTO-RETRAIN] Pipeline failed with exit code ${code}`)
        return reject(`❌ Retrain Pipeline failed with exit code ${code}`)
      }

      logger.info(`✅ [AUTO-RETRAIN] Retraining process finished smoothly.`)

      if (fs.existsSync(MODEL_PATH)) {
        const newModTime = fs.statSync(MODEL_PATH).mtimeMs
        if (newModTime > oldModTime) {
          logger.info(`🧬 [V19-DUEL] Model updated. Starting Model Duel (Backtest Validation)...`)

          const AUDIT_SCRIPT = path.join(__dirname, 'audit_performance.py')
          const auditProcess = spawn(pythonPath, [AUDIT_SCRIPT, '--last', '50'], {
            env,
            windowsHide: true,
          })
          auditProcess.on('error', (e) =>
            logger.error(`[AUTO-RETRAIN] Audit spawn error: ${e.message}`)
          )

          let auditOutput = ''
          auditProcess.stdout.on('data', (d) => (auditOutput += d.toString()))

          auditProcess.on('close', (auditCode) => {
            logger.info(`📊 [V19-RESULTS] Performance Audit:\n${auditOutput.trim()}`)

            let outcome = ''
            if (auditOutput.includes('IMPROVEMENT') || auditOutput.includes('STABLE')) {
              outcome = `🏆 <b>SUCCESS:</b> New model validated and deployed.`
              logger.info(outcome)
            } else if (auditOutput.includes('REGRESSION')) {
              outcome = `⚠️ <b>WARNING:</b> Model regression detected. Monitoring active.`
              logger.warn(outcome)
            } else {
              outcome = `✅ Model updated successfully.`
            }

            reportMsg += `${outcome}\n🔄 Prediction Engine is now using the newly trained model.`
            resolve({ success: true, message: reportMsg })
          })
        } else {
          const msg = `⚠️ Model file timestamp didn't change. Evaluation possibly skipped.`
          logger.warn(msg)
          resolve({ success: false, message: msg })
        }
      } else {
        const msg = `❌ CRITICAL: Expected model file not found at ${MODEL_PATH}`
        logger.error(msg)
        reject(msg)
      }
    })
  })
}

/**
 * Runs the Live Goal Prediction Model Training Pipeline.
 */
function runLiveModelRetrain() {
  return new Promise((resolve) => {
    logger.info(`[LIVE-RETRAIN] Starting live goal model training...`)

    const pythonPath = _findPython()

    const pythonProcess = spawn(pythonPath, [LIVE_TRAIN_SCRIPT], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    })
    pythonProcess.on('error', (e) =>
      logger.error(`[AUTO-RETRAIN] Live train spawn error: ${e.message}`)
    )

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString().trim()
      if (output) logger.info(`[LIVE-MODEL] ${output}`)
    })

    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString().trim()
      if (output) logger.warn(`[LIVE-MODEL-WARN] ${output}`)
    })

    pythonProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(LIVE_MODEL_PATH)) {
        logger.info(`✅ [LIVE-RETRAIN] Live goal model updated successfully.`)
        resolve({ success: true, message: 'Live goal model retrained' })
      } else {
        logger.warn(`⚠️ [LIVE-RETRAIN] Live model training exited with code ${code}`)
        resolve({ success: false, message: `Live model exit code ${code}` })
      }
    })
  })
}

// Execute normally if run directly from terminal/cron
if (require.main === module) {
  runAutoRetrain()
    .then((res) => {
      if (res.success) {
        import botService from '../services/botService'
        botService.sendAlert(`🔥 <b>TITANIUM AUTO-RETRAIN</b> 🔥\n\n${res.message}`)
        // Wait briefly for telegram to send
        setTimeout(() => process.exit(0), 1000)
      } else {
        process.exit(1)
      }
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}

/**
 * Runs the V56 Auto-Retrain Pipeline (chronological split, 22 features).
 * Spawns scripts/auto_retrain.py and logs results.
 */
function runV56Retrain() {
  return new Promise(async (resolve) => {
    logger.info(`[V56-RETRAIN] Starting V56 model retraining...`)

    // Step 0: Generate backtest feedback weights
    await runBacktestFeedback()

    // Step 0.5: Generate calibration weights from Brier/LogLoss
    await runCalibrationFeedback()

    const pythonPath = _findPython()

    const script = path.join(__dirname, 'auto_retrain.py')
    const proc = spawn(pythonPath, [script], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      timeout: 600000,
    })
    proc.on('error', (e) => logger.error(`[AUTO-RETRAIN] Script spawn error: ${e.message}`))

    let stdout = ''
    proc.stdout.on('data', (d) => {
      const s = d.toString()
      stdout += s
      logger.info(`[V56] ${s.trim()}`)
    })
    proc.stderr.on('data', (d) => logger.warn(`[V56-WARN] ${d.toString().trim()}`))
    proc.on('close', (code) => {
      if (code === 0) {
        logger.info(`✅ [V56-RETRAIN] V56 model updated successfully`)
        resolve({ success: true, message: `V56 retrained (exit 0)` })
      } else {
        logger.warn(`⚠️ [V56-RETRAIN] exited with code ${code}`)
        resolve({ success: false, message: `V56 exit code ${code}` })
      }
    })
    proc.on('error', (e) => {
      logger.error(`[V56-RETRAIN] spawn error: ${e.message}`)
      resolve({ success: false, message: e.message })
    })
  })
}

export = { runAutoRetrain, runLiveModelRetrain, runV56Retrain }
