const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const sqlite = require('better-sqlite3')

const logger = console
const DB_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const STATE_FILE = path.join(__dirname, '..', 'data', 'online_learning_state.json')
const LOG_FILE = path.join(__dirname, '..', 'data', 'online_learning_log.json')
const AUDIT_SCRIPT = path.join(__dirname, 'audit_performance.py')
const PYTHON_WIN = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
const PYTHON_NIX = path.join(__dirname, '..', '.venv', 'bin', 'python3')

function getLastLearnedId() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastLearnedId || 0
    }
  } catch (_) {}
  return 0
}

function saveLastLearnedId(id) {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastLearnedId: id, updatedAt: new Date().toISOString() })
    )
  } catch (_) {}
}

function appendLog(entry) {
  try {
    const logs = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : []
    logs.push({ ...entry, timestamp: new Date().toISOString() })
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2))
  } catch (_) {}
}

function sendTelegram(message) {
  try {
    const botService = require('../services/botService')
    botService.sendAlert(message)
  } catch (_) {}
}

function resolvePython() {
  if (fs.existsSync(PYTHON_WIN)) return PYTHON_WIN
  if (fs.existsSync(PYTHON_NIX)) return PYTHON_NIX
  return 'python3'
}

function runAudit() {
  return new Promise((resolve) => {
    const pythonExe = resolvePython()
    const proc = spawn(pythonExe, [AUDIT_SCRIPT, '--last', '50'], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    })
    proc.on('error', (e) => {
      logger.warn(`[AUDIT] Spawn error: ${e.message}`)
      resolve({ code: -1, output: '' })
    })
    let output = ''
    proc.stdout.on('data', (d) => (output += d.toString()))
    proc.stderr.on('data', (d) => logger.warn(`[AUDIT-ERR] ${d.toString().trim()}`))
    proc.on('close', (code) => resolve({ code, output }))
  })
}

async function runOnlineUpdate() {
  logger.info('🔄 [ONLINE-LEARNING] Checking for new data to update models...')

  let db
  try {
    if (!fs.existsSync(DB_PATH)) {
      logger.info('✅ [ONLINE-LEARNING] No historical archive DB found.')
      return
    }

    db = new sqlite(DB_PATH)
    const lastLearnedId = getLastLearnedId()

    const matches = db
      .prepare(
        `
      SELECT * FROM archive_matches 
      WHERE stats_blob IS NOT NULL AND id > ?
      ORDER BY id ASC LIMIT 50
    `
      )
      .all(lastLearnedId)

    if (matches.length === 0) {
      logger.info('✅ [ONLINE-LEARNING] No new data found for incremental update.')
      db.close()
      return
    }

    logger.info(
      `📈 [ONLINE-LEARNING] Feeding ${matches.length} matches to V54 incremental update...`
    )

    const tmpDir = path.join(__dirname, '..', 'data')
    const dataPath = path.join(tmpDir, `online_batch_${Date.now()}.json`)
    const scriptPath = path.join(tmpDir, `online_update_${Date.now()}.py`)

    fs.writeFileSync(dataPath, JSON.stringify(matches))

    const pyScript = `import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), 'core'))
try:
    import pandas as pd
    import numpy as np
    import xgboost as xgb
    from ml_features import extract_ml_features, FEATURE_NAMES_V54
except ImportError as e:
    print(f"MISSING_DEP:{e}")
    sys.exit(2)

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'models', 'stitch_v24_hybrid.json')
data_path = sys.argv[1]
with open(data_path) as f:
    matches = json.load(f)

data, labels = [], []
for row in matches:
    try:
        feats = extract_ml_features(row, fetch_history=False)
        data.append([feats.get(f, 0) for f in FEATURE_NAMES_V54])
        hg, ag = row['scoreHome'], row['scoreAway']
        if hg > ag: labels.append(0)
        elif hg == ag: labels.append(1)
        else: labels.append(2)
    except Exception as e:
        print(f"Skipping match {row.get('id', '?')}: {e}")
        continue

if data and os.path.exists(MODEL_PATH):
    X_new = pd.DataFrame(data, columns=FEATURE_NAMES_V54)
    y_new = np.array(labels)
    old_booster = xgb.Booster()
    old_booster.load_model(MODEL_PATH)
    dnew = xgb.DMatrix(X_new, label=y_new, feature_names=FEATURE_NAMES_V54)
    updated = xgb.train({'objective': 'multi:softprob', 'num_class': 3, 'eval_metric': 'mlogloss'},
                        dnew, num_boost_round=10, xgb_model=old_booster)
    updated.save_model(MODEL_PATH)
    print("SUCCESS")
elif not data:
    print("NO_DATA")
else:
    print(f"MODEL_MISSING:{MODEL_PATH}")
`
    fs.writeFileSync(scriptPath, pyScript)

    const pythonExe = resolvePython()

    const pyProcess = spawn(pythonExe, [scriptPath, dataPath], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    pyProcess.on('error', (e) => logger.error(`[ONLINE-LEARN] Spawn error: ${e.message}`))

    let stdout = ''
    pyProcess.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      logger.info(`[PYTHON] ${text.trim()}`)
    })
    pyProcess.stderr.on('data', (d) => logger.warn(`[PYTHON-ERR] ${d.toString().trim()}`))

    pyProcess.on('close', async (code) => {
      try {
        if (fs.existsSync(dataPath)) fs.unlinkSync(dataPath)
      } catch (_) {}
      try {
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)
      } catch (_) {}
      if (db && db.open) db.close()

      const success = code === 0 && stdout.includes('SUCCESS')
      const maxId = matches.reduce((max, m) => Math.max(max, m.id || 0), 0)

      if (success) {
        saveLastLearnedId(maxId)
        logger.info('✅ [ONLINE-LEARNING] Incremental update complete.')

        // Run audit to validate the update
        logger.info('📊 [ONLINE-LEARNING] Running validation audit...')
        const audit = await runAudit()

        const auditResult = audit.output.includes('IMPROVEMENT')
          ? 'IMPROVEMENT'
          : audit.output.includes('STABLE')
            ? 'STABLE'
            : audit.output.includes('REGRESSION')
              ? 'REGRESSION'
              : 'UNKNOWN'

        appendLog({
          event: 'update',
          matchesProcessed: matches.length,
          lastLearnedId: maxId,
          auditResult,
          auditOutput: audit.output.trim(),
        })

        const msg = `🧠 <b>ONLINE LEARNING UPDATE</b> 🧠\n\n📈 Matchs traités: ${matches.length}\n📊 Audit: ${auditResult}\n💾 Dernier ID: ${maxId}`
        sendTelegram(msg)
        logger.info(`📊 [ONLINE-LEARNING] Audit result: ${auditResult}`)
      } else if (code === 0 && stdout.includes('NO_DATA')) {
        logger.info('✅ [ONLINE-LEARNING] No valid matches to learn from.')
        appendLog({ event: 'no_data', matchesProcessed: 0 })
      } else {
        const errMsg = `❌ [ONLINE-LEARNING] Update failed with code ${code}`
        logger.error(errMsg)
        appendLog({ event: 'failure', matchesProcessed: matches.length, error: errMsg })
        sendTelegram(
          `❌ <b>ONLINE LEARNING FAILED</b> ❌\n\nCode: ${code}\nMatches: ${matches.length}`
        )
      }
    })
  } catch (err) {
    logger.error('💥 [ONLINE-LEARNING] Error:', err.message)
    if (db && db.open) db.close()
    appendLog({ event: 'crash', error: err.message })
  }
}

if (require.main === module) {
  runOnlineUpdate()
}

module.exports = { runOnlineUpdate }
