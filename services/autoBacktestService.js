/**
 * AutoBacktestService
 * Daily automated backtesting + weight adjustment.
 * 
 * Flow:
 * 1. Fetch finished matches from last 24h with predictions + scores
 * 2. Compare predicted 1X2/O/U/BTTS vs actual results
 * 3. Compute accuracy by league, by confidence bracket, by market
 * 4. Persist results to data/backtest_results.json
 * 5. Adjust XGBoost/Poisson blend weights per league → data/league_dynamic_weights.json
 * 6. Feed accuracy history into confidenceScorer
 */
const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');
const database = require('../core/database');

const RESULTS_PATH = path.join(__dirname, '../data/backtest_results.json');
const WEIGHTS_PATH = path.join(__dirname, '../data/league_dynamic_weights.json');
const HISTORY_PATH = path.join(__dirname, '../data/accuracy_trend.json');

function _loadJson(p, def = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function _saveJson(p, data) {
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 0));
  } catch (e) { logger.warn(`[BACKTEST] Save failed: ${e.message}`); }
}

/**
 * Determine actual outcome from scores.
 */
function getActualOutcome(scoreHome, scoreAway) {
  if (scoreHome > scoreAway) return '1';
  if (scoreHome < scoreAway) return '2';
  return 'X';
}

function getActualOU(totalGoals, line = 2.5) {
  return totalGoals > line ? 'OVER' : totalGoals < line ? 'UNDER' : 'PUSH';
}

function getActualBTTS(scoreHome, scoreAway) {
  return scoreHome > 0 && scoreAway > 0 ? 'YES' : 'NO';
}

/**
 * Determine if a prediction was correct.
 */
function evaluatePrediction(match) {
  const scoreH = parseInt(match.score_home);
  const scoreA = parseInt(match.score_away);
  if (isNaN(scoreH) || isNaN(scoreA)) return null;

  const totalGoals = scoreH + scoreA;
  const actual1x2 = getActualOutcome(scoreH, scoreA);
  const actualOU = getActualOU(totalGoals);
  const actualBTTS = getActualBTTS(scoreH, scoreA);

  const predicted = (match.prediction || '').trim().toUpperCase();
  const pHome = parseFloat(match.home_win_probability || 0);
  const pDraw = parseFloat(match.draw_probability || 0);
  const pAway = parseFloat(match.away_win_probability || 0);
  const confidence = parseFloat(match.xgboost_confidence || match.confidence || 0);

  // 1X2 result
  let result1x2 = null;
  if (['1', 'X', '2'].includes(predicted)) {
    result1x2 = predicted === actual1x2 ? 'WON' : 'LOST';
  } else if (predicted.includes('1X')) {
    result1x2 = (actual1x2 === '1' || actual1x2 === 'X') ? 'WON' : 'LOST';
  } else if (predicted.includes('X2')) {
    result1x2 = (actual1x2 === 'X' || actual1x2 === '2') ? 'WON' : 'LOST';
  } else if (predicted.includes('12')) {
    result1x2 = (actual1x2 === '1' || actual1x2 === '2') ? 'WON' : 'LOST';
  }

  // Best pick (highest probability)
  const bestPick = pHome >= pDraw && pHome >= pAway ? '1' : pAway >= pDraw ? '2' : 'X';
  const bestPickResult = bestPick === actual1x2 ? 'WON' : 'LOST';

  // Odds-based implied pick
  const oddsH = parseFloat(match.odds_home || 0);
  const oddsD = parseFloat(match.odds_draw || 0);
  const oddsA = parseFloat(match.odds_away || 0);
  let oddsPick = 'X';
  if (oddsH > 0 && oddsH <= oddsD && oddsH <= oddsA) oddsPick = '1';
  else if (oddsA > 0 && oddsA <= oddsH && oddsA <= oddsD) oddsPick = '2';
  const oddsPickResult = oddsPick === actual1x2 ? 'WON' : 'LOST';

  return {
    matchId: match.id,
    league: match.league || match.tournament_name || 'Unknown',
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    scoreHome: scoreH,
    scoreAway: scoreA,
    totalGoals,
    predicted,
    bestPick,
    oddsPick,
    actual1x2,
    actualOU,
    actualBTTS,
    result1x2,
    bestPickResult,
    oddsPickResult,
    pHome, pDraw, pAway,
    confidence,
    oddsHome: oddsH,
    oddsDraw: oddsD,
    oddsAway: oddsA,
    aiSource: match.ai_source || 'unknown',
    timestamp: Date.now(),
  };
}

/**
 * Run the auto-backtest on recently finished matches.
 */
async function runAutoBacktest() {
  logger.info('[BACKTEST] Starting auto-backtest...');
  const startTime = Date.now();

  try {
    // Get finished matches from last 48h with scores
    const allMatches = await database.getAllMatches();
    const recentFinished = allMatches.filter(m => {
      const scoreH = parseInt(m.score_home);
      const scoreA = parseInt(m.score_away);
      if (isNaN(scoreH) || isNaN(scoreA)) return false;
      const ts = m.startTimestamp || m.timestamp;
      if (!ts) return false;
      const matchTime = typeof ts === 'string' ? new Date(ts).getTime() : (parseInt(ts) > 1e11 ? parseInt(ts) : parseInt(ts) * 1000);
      const cutoff = Date.now() - (72 * 60 * 60 * 1000); // last 72h
      return matchTime >= cutoff;
    });

    if (recentFinished.length === 0) {
      logger.info('[BACKTEST] No recently finished matches to evaluate.');
      return { processed: 0 };
    }

    logger.info(`[BACKTEST] Evaluating ${recentFinished.length} finished matches...`);

    // Evaluate each match
    const results = recentFinished.map(evaluatePrediction).filter(Boolean);

    // ── Per-league accuracy ──
    const leagueStats = {};
    for (const r of results) {
      const lg = r.league;
      if (!leagueStats[lg]) {
        leagueStats[lg] = { correct: 0, total: 0, correctBest: 0, correctOdds: 0, sumConfidence: 0, results: [] };
      }
      leagueStats[lg].total++;
      if (r.result1x2 === 'WON') leagueStats[lg].correct++;
      if (r.bestPickResult === 'WON') leagueStats[lg].correctBest++;
      if (r.oddsPickResult === 'WON') leagueStats[lg].correctOdds++;
      leagueStats[lg].sumConfidence += r.confidence;
      leagueStats[lg].results.push(r);
    }

    for (const lg of Object.keys(leagueStats)) {
      const s = leagueStats[lg];
      s.accuracy = s.total > 0 ? +(s.correct / s.total * 100).toFixed(1) : 0;
      s.bestPickAccuracy = s.total > 0 ? +(s.correctBest / s.total * 100).toFixed(1) : 0;
      s.oddsAccuracy = s.total > 0 ? +(s.correctOdds / s.total * 100).toFixed(1) : 0;
      s.avgConfidence = s.total > 0 ? +(s.sumConfidence / s.total).toFixed(1) : 0;
      s.edge = +(s.accuracy - s.oddsAccuracy).toFixed(1); // model vs odds-implied
    }

    // ── Per-confidence-bracket accuracy ──
    const brackets = { '0-50': { c: 0, t: 0 }, '50-60': { c: 0, t: 0 }, '60-70': { c: 0, t: 0 }, '70-80': { c: 0, t: 0 }, '80-90': { c: 0, t: 0 }, '90+': { c: 0, t: 0 } };
    for (const r of results) {
      const conf = r.confidence > 1 ? r.confidence : r.confidence * 100;
      let key;
      if (conf >= 90) key = '90+';
      else if (conf >= 80) key = '80-90';
      else if (conf >= 70) key = '70-80';
      else if (conf >= 60) key = '60-70';
      else if (conf >= 50) key = '50-60';
      else key = '0-50';
      brackets[key].t++;
      if (r.result1x2 === 'WON') brackets[key].c++;
    }

    const bracketSummary = {};
    for (const [k, v] of Object.entries(brackets)) {
      bracketSummary[k] = {
        accuracy: v.t > 0 ? +(v.c / v.t * 100).toFixed(1) : 0,
        count: v.t
      };
    }

    // ── Overall stats ──
    const totalCorrect = results.filter(r => r.result1x2 === 'WON').length;
    const totalBest = results.filter(r => r.bestPickResult === 'WON').length;
    const totalOdds = results.filter(r => r.oddsPickResult === 'WON').length;
    const avgConfidence = results.length > 0 ? +(results.reduce((s, r) => s + r.confidence, 0) / results.length).toFixed(1) : 0;

    const overallAccuracy = results.length > 0 ? +(totalCorrect / results.length * 100).toFixed(1) : 0;
    const overallBest = results.length > 0 ? +(totalBest / results.length * 100).toFixed(1) : 0;
    const overallOdds = results.length > 0 ? +(totalOdds / results.length * 100).toFixed(1) : 0;

    const backtestResult = {
      timestamp: new Date().toISOString(),
      period: `Last 72h`,
      totalMatches: results.length,
      overall: {
        accuracy: overallAccuracy,
        bestPickAccuracy: overallBest,
        oddsImpliedAccuracy: overallOdds,
        edge: +(overallAccuracy - overallOdds).toFixed(1),
        avgConfidence,
      },
      bracketAccuracy: bracketSummary,
      leagueBreakdown: Object.fromEntries(
        Object.entries(leagueStats)
          .filter(([_, s]) => s.total >= 2)
          .sort((a, b) => b[1].accuracy - a[1].accuracy)
          .map(([lg, s]) => [lg, { accuracy: s.accuracy, bestPick: s.bestPickAccuracy, odds: s.oddsAccuracy, edge: s.edge, avgConf: s.avgConfidence, matches: s.total }])
      ),
    };

    // ── Persist results ──
    const history = _loadJson(HISTORY_PATH, []);
    history.push(backtestResult);
    if (history.length > 90) history.splice(0, history.length - 90);
    _saveJson(HISTORY_PATH, history);
    _saveJson(RESULTS_PATH, backtestResult);

    // ── Adjust dynamic weights per league ──
    const dynamicWeights = _computeDynamicWeights(leagueStats);
    _saveJson(WEIGHTS_PATH, dynamicWeights);

    // ── Feed into confidenceScorer ──
    try {
      const confidenceScorer = require('../core/confidenceScorer');
      for (const r of results) {
        confidenceScorer.recordSettlement(r.league, '1X2', r.result1x2 === 'WON');
      }
    } catch (_) {}

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`[BACKTEST] Done in ${elapsed}s — ${results.length} matches, accuracy: ${overallAccuracy}% (edge vs odds: ${backtestResult.overall.edge}%)`);

    return backtestResult;

  } catch (e) {
    logger.error(`[BACKTEST] Error: ${e.message}`);
    return { error: e.message };
  }
}

/**
 * Compute dynamic XGBoost/Poisson blend weights per league.
 * If model accuracy > odds accuracy → increase XGB weight.
 * If model accuracy < odds accuracy → decrease XGB weight.
 * If insufficient data → keep DEFAULT.
 */
function _computeDynamicWeights(leagueStats) {
  const DEFAULT_XGB = 0.75;
  const MIN_MATCHES = 3;
  const MIN_ACCURACY = 25; // below random, don't trust
  const MAX_ACCURACY = 95;

  const weights = {};

  for (const [lg, stats] of Object.entries(leagueStats)) {
    if (stats.total < MIN_MATCHES) continue;

    const acc = Math.max(MIN_ACCURACY, Math.min(MAX_ACCURACY, stats.accuracy));
    const oddsAcc = Math.max(MIN_ACCURACY, Math.min(MAX_ACCURACY, stats.oddsAccuracy));

    // If model beats odds: increase XGB weight
    // If model loses to odds: decrease XGB weight
    const edge = acc - oddsAcc;

    let xgbWeight = DEFAULT_XGB;

    if (edge > 5) {
      // Model is significantly better than odds — trust it more
      xgbWeight = Math.min(0.95, DEFAULT_XGB + (edge / 100) * 0.5);
    } else if (edge < -5) {
      // Model is worse than odds — trust odds more (Poisson)
      xgbWeight = Math.max(0.40, DEFAULT_XGB + (edge / 100) * 0.5);
    }

    // If overall accuracy is very low, reduce trust
    if (acc < 35) {
      xgbWeight = Math.max(0.30, xgbWeight * 0.7);
    }

    // If accuracy is very high, boost confidence
    if (acc > 65) {
      xgbWeight = Math.min(0.98, xgbWeight * 1.1);
    }

    // News boost: inversely proportional to accuracy (more news needed when model is weak)
    const newsBoost = Math.max(0.10, Math.min(0.80, 0.30 + (50 - acc) / 200));

    weights[lg] = {
      xgb_weight: +xgbWeight.toFixed(3),
      news_boost: +newsBoost.toFixed(3),
      model_accuracy: stats.accuracy,
      odds_accuracy: stats.oddsAccuracy,
      edge: +edge.toFixed(1),
      matches: stats.total,
      updated: new Date().toISOString(),
    };
  }

  // Always include default
  weights['DEFAULT'] = { xgb_weight: DEFAULT_XGB, news_boost: 0.30, updated: new Date().toISOString() };

  return weights;
}

module.exports = { runAutoBacktest, evaluatePrediction };
