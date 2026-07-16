const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const WEIGHTS_PATH = path.join(__dirname, '../config/model_weights.json');
const HIST_PATH = path.join(__dirname, '../data/accuracy_history.json');
const HIST_CACHE = new Map();

function loadWeights() {
  try {
    if (!fs.existsSync(WEIGHTS_PATH)) return null;
    return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Compute "Force du Pronostic" — a calibrated 0–95% confidence score.
 *
 * @param {Object} opts
 * @param {string}  opts.mainPick        — '1' | 'X' | '2' | '1X' | 'X2' | '12'
 * @param {number}  opts.topProb         — probability of the main pick (0–1)
 * @param {number}  opts.secondProb      — probability of the second best pick (0–1)
 * @param {number}  [opts.baseSolidMargin] — dominance gap in percentage points
 * @param {number}  [opts.insufficientData] — 0 | 1
 * @param {string}  [opts.league]        — league name for historical lookup
 * @param {string}  [opts.marketType]    — '1X2' | 'DC' | 'OU' | 'BTTS'
 *
 * @returns {{ confidence: number, breakdown: Object }}
 */
function computeConfidence(opts) {
  const {
    mainPick,
    topProb,
    secondProb,
    baseSolidMargin,
    insufficientData = 0,
    league = '',
    marketType = '1X2',
  } = opts;

  if (topProb == null || secondProb == null) {
    return { confidence: 50, breakdown: { error: 'missing probabilities' } };
  }

  const weights = loadWeights();
  const drawBias = weights?.draw_bias ?? 1.0;
  const bsmThreshold = weights?.bsm_threshold ?? 25;

  // ── 1. Base probability (0–40 pts) ──────────────────────────
  const baseScore = Math.round(Math.min(topProb, 0.95) * 40);

  // ── 2. Dominance margin (0–30 pts) ──────────────────────────
  const margin = topProb - secondProb;
  const marginPct = Math.round(margin * 100);             // e.g. 22 → 22%
  const dominanceScore = Math.min(30, Math.round(marginPct * 0.6));

  // ── 3. Draw-bias adjustment (−10 … +5 pts) ─────────────────
  let drawAdjust = 0;
  if (mainPick === 'X') {
    if (drawBias > 1.0) drawAdjust = Math.min(5, Math.round((drawBias - 1.0) * 8));
  } else if (['1', '2', '1X', 'X2', '12'].includes(mainPick)) {
    if (drawBias > 1.2) drawAdjust = -Math.min(10, Math.round((drawBias - 1.2) * 15));
  }

  // ── 4. BSM quality (0–15 pts) ──────────────────────────────
  const bsmScore = (baseSolidMargin != null && marginPct >= bsmThreshold)
    ? Math.min(15, Math.round((marginPct - bsmThreshold) * 0.8))
    : 0;

  // ── 5. Data quality (0–10 pts) ─────────────────────────────
  const dataScore = insufficientData ? 0 : 10;

  // ── 6. League-based history bonus (−5 … +5 pts) ────────────
  let historyBonus = 0;
  const histKey = `${league}::${marketType}`;
  const cached = HIST_CACHE.get(histKey);
  if (cached && cached.count >= 10) {
    const wr = cached.wins / cached.count;
    if (wr > 0.65) historyBonus = Math.min(5, Math.round((wr - 0.65) * 20));
    else if (wr < 0.45) historyBonus = -Math.min(5, Math.round((0.45 - wr) * 20));
  }

  // ── Raw total ───────────────────────────────────────────────
  let total = baseScore + dominanceScore + drawAdjust + bsmScore + dataScore + historyBonus;
  total = Math.max(5, Math.min(100, total));

  // ── Over-calibration safeguards ─────────────────────────────
  if (!baseSolidMargin || baseSolidMargin <= 0) {
    total = Math.min(total, 75); // no edge → never exceed 75
  }
  if (total >= 98) total = 95 + Math.round((total - 98) / 2); // 98→95, 99→95, 100→96
  if (total > 95) total = 95; // hard ceiling

  return {
    confidence: total,
    breakdown: {
      baseScore,
      dominanceScore,
      drawAdjust,
      bsmScore,
      dataScore,
      historyBonus,
      drawBiasUsed: drawBias,
      bsmThresholdUsed: bsmThreshold,
      finalMarginPct: marginPct,
    },
  };
}

/**
 * Feed back a settled result so future confidence calculations
 * can incorporate historical win-rate per league + market type.
 * Call this from the settlement pipeline.
 */
function recordSettlement(league, marketType, won) {
  const key = `${league}::${marketType}`;
  if (!HIST_CACHE.has(key)) HIST_CACHE.set(key, { wins: 0, count: 0 });
  const entry = HIST_CACHE.get(key);
  entry.count++;
  if (won) entry.wins++;
  _saveHistory();
}

function _saveHistory() {
  try {
    const obj = {};
    for (const [k, v] of HIST_CACHE) obj[k] = v;
    fs.writeFileSync(HIST_PATH, JSON.stringify(obj, null, 0));
  } catch (e) {
    logger.warn(`[CONFIDENCE] Failed to save history: ${e.message}`);
  }
}

function _loadHistory() {
  try {
    if (fs.existsSync(HIST_PATH)) {
      const obj = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
      for (const [k, v] of Object.entries(obj)) HIST_CACHE.set(k, v);
      logger.info(`[CONFIDENCE] Loaded ${HIST_CACHE.size} accuracy history entries`);
    }
  } catch (e) {
    logger.warn(`[CONFIDENCE] Failed to load history: ${e.message}`);
  }
}

_loadHistory();

module.exports = { computeConfidence, loadWeights, recordSettlement };
