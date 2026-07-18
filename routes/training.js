const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');

const { runAutoRetrain, runLiveModelRetrain, runV56Retrain } = require('../scripts/auto_retrain_worker');
const MODELS_DIR = path.join(__dirname, '..', 'models');
const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

const trainState = { running: false, type: null, startedAt: null, lastResult: null, log: [] };

const MODELS_CONFIG = [
  { id: 'v24', name: 'XGBoost V24', file: 'stitch_v24_hybrid.json', script: 'core/train_v24_top_analyst.py', cron: '1er du mois 04:00', worker: 'runAutoRetrain' },
  { id: 'v56', name: 'XGBoost V56 Auto', file: 'stitch_v553_premium.json', script: 'scripts/auto_retrain.py', cron: 'Samedi 23:30', worker: 'runV56Retrain' },
  { id: 'live', name: 'Live Goal', file: 'live_goal_xgb.json', script: 'core/train_live_model.py', cron: 'Dimanche 05:00', worker: 'runLiveModelRetrain' },
  { id: 'promosport', name: 'Promosport', file: 'promosport_xgb.json', script: 'scripts/train_promosport_xgboost.py', cron: 'Samedi 04:00', worker: 'promosport' },
  { id: 'titanium', name: 'Titanium V4', file: 'titanium_v4.json', script: 'scripts/auto_retrain.py', cron: 'Mensuel', worker: 'runV56Retrain' },
  { id: 'corners', name: 'Corners', file: 'stitch_corners_v1.json', script: 'core/train_secondary_markets.py', cron: '—', worker: null },
  { id: 'cards', name: 'Cartons', file: 'stitch_cards_v1.json', script: 'core/train_secondary_markets.py', cron: '—', worker: null },
];

function getModelInfo(id) {
  const cfg = MODELS_CONFIG.find(m => m.id === id);
  if (!cfg) return null;
  const modelPath = path.join(MODELS_DIR, cfg.file);
  let stats = null;
  try { stats = fs.statSync(modelPath); } catch (_) {}
  return { ...cfg, path: modelPath, exists: !!stats, sizeKB: stats ? Math.round(stats.size / 1024) : 0, modifiedAt: stats ? stats.mtime : null };
}

async function runStep(name, cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn(cmd, args, { cwd: path.join(__dirname, '..'), timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { const s = d.toString(); out += s; trainState.log.push(`[${name}] ${s.trim()}`); if (trainState.log.length > 200) trainState.log.splice(0, 50); });
    child.stderr.on('data', d => { const s = d.toString(); out += s; trainState.log.push(`[${name}] ${s.trim()}`); if (trainState.log.length > 200) trainState.log.splice(0, 50); });
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${name} exited ${code}: ${out.slice(-300)}`)));
    child.on('error', reject);
  });
}

router.get('/models', (req, res) => {
  const models = MODELS_CONFIG.map(m => getModelInfo(m.id));
  res.json({ success: true, models });
});

router.get('/status', (req, res) => {
  res.json({ success: true, running: trainState.running, type: trainState.type, startedAt: trainState.startedAt, lastResult: trainState.lastResult, log: trainState.log.slice(-50) });
});

router.post('/retrain/:type', async (req, res) => {
  const { type } = req.params;
  if (trainState.running) return res.status(409).json({ success: false, error: `Déjà en cours: ${trainState.type}` });
  const cfg = MODELS_CONFIG.find(m => m.id === type);
  if (!cfg) return res.status(400).json({ success: false, error: `Type inconnu: ${type}` });

  trainState.running = true;
  trainState.type = type;
  trainState.startedAt = new Date().toISOString();
  trainState.lastResult = null;
  trainState.log = [];
  res.json({ success: true, status: 'started', type });

  try {
    trainState.log.push(`[SYSTEM] Démarrage du retrain ${cfg.name}...`);

    if (type === 'promosport') {
      const scriptsDir = path.join(__dirname, '..', 'scripts');
      const importOut = await runStep('Import', pythonCmd, [path.join(scriptsDir, 'import_promosport_archive.py')], 120000);
      const trainOut = await runStep('Train', pythonCmd, [path.join(scriptsDir, 'train_promosport_xgboost.py')], 600000);
      const accMatch = trainOut.match(/Accuracy: ([\d.]+)%/);
      const llMatch = trainOut.match(/Log Loss: ([\d.]+)/);
      const steps = [
        { step: 'import', output: importOut.trim().split('\n').filter(l => l).slice(-2).join('; ') },
        { step: 'train', accuracy: accMatch ? parseFloat(accMatch[1]) : null, logLoss: llMatch ? parseFloat(llMatch[1]) : null }
      ];
      try {
        const promosportMLService = require('../services/promosportMLService');
        promosportMLService.reloadModel();
        steps.push({ step: 'reload', success: true });
      } catch (_) {}
      trainState.lastResult = { success: true, steps, finishedAt: new Date().toISOString() };
    } else if (type === 'v24') {
      const result = await runAutoRetrain();
      trainState.lastResult = { success: true, details: result, finishedAt: new Date().toISOString() };
    } else if (type === 'v56') {
      const result = await runV56Retrain();
      trainState.lastResult = { success: true, details: result, finishedAt: new Date().toISOString() };
    } else if (type === 'live') {
      const result = await runLiveModelRetrain();
      trainState.lastResult = { success: true, details: result, finishedAt: new Date().toISOString() };
    } else {
      const scriptPath = path.join(__dirname, '..', cfg.script);
      const out = await runStep('Train', pythonCmd, [scriptPath], 600000);
      const accMatch = out.match(/accuracy[:\s]+([\d.]+)/i);
      trainState.lastResult = { success: true, steps: [{ step: 'train', accuracy: accMatch ? parseFloat(accMatch[1]) : null, output: out.trim().slice(-200) }], finishedAt: new Date().toISOString() };
    }

    trainState.log.push(`[SYSTEM] ✓ Retrain ${cfg.name} terminé`);
    logger.info(`[TRAINING] Retrain ${type} successful`);
  } catch (err) {
    logger.error(`[TRAINING] Retrain ${type} failed: ${err.message}`);
    trainState.lastResult = { success: false, error: err.message, finishedAt: new Date().toISOString() };
    trainState.log.push(`[SYSTEM] ✗ Échec: ${err.message}`);
  } finally {
    trainState.running = false;
    trainState.type = null;
    trainState.startedAt = null;
  }
});

router.get('/history', (req, res) => {
  const models = MODELS_CONFIG.map(m => {
    const info = getModelInfo(m.id);
    return { id: m.id, name: m.name, file: m.file, exists: info.exists, sizeKB: info.sizeKB, modifiedAt: info.modifiedAt, cron: m.cron };
  });
  res.json({ success: true, history: models });
});

module.exports = router;