/**
 * fallback_enricher.js — Pure-JS Fallback Enrichment Engine
 * 
 * Computes 1X2 + O/U 2.5 probabilities using Poisson distribution.
 * No Python/FastAPI dependency. Runs inside the Node.js server.
 */

const logger = require('./logger');
const database = require('./database');

// ── Math helpers ──────────────────────────────────────────────────

function factorial(n) {
  if (n < 2) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonProb(x, lambda) {
  if (lambda <= 0) return x === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, x) / factorial(x);
}

// ── Score matrix ──────────────────────────────────────────────────

function buildScoreMatrix(xgHome, xgAway, maxGoals = 8) {
  const matrix = [];
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    const ph = poissonProb(h, xgHome);
    for (let a = 0; a <= maxGoals; a++) {
      const pa = poissonProb(a, xgAway);
      matrix[h][a] = ph * pa;
    }
  }
  return matrix;
}

function calculateMarkets(matrix) {
  const maxGoals = matrix.length - 1;
  let home = 0, draw = 0, away = 0;
  let over25 = 0, bttsYes = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a > 2.5) over25 += p;
      if (h > 0 && a > 0) bttsYes += p;
    }
  }

  const total = home + draw + away;
  if (total > 0) {
    home /= total;
    draw /= total;
    away /= total;
  }

  return { home, draw, away, over_25: over25, btts_yes: bttsYes };
}

function determinePick(pHome, pDraw, pAway) {
  const picks = [
    { label: '1', prob: pHome },
    { label: 'X', prob: pDraw },
    { label: '2', prob: pAway },
  ];
  picks.sort((a, b) => b.prob - a.prob);
  const best = picks[0];
  const ev = Math.round((best.prob / 100 * 2.0 - 1.0) * 100) / 100;
  return { pick: best.label, prob: Math.round(best.prob * 10) / 10, ev };
}

// ── Enrich a single match ────────────────────────────────────────

function enrichOne(match) {
  const matchId = match.id || match.match_id || '';
  const home = match.homeTeam || '';
  const away = match.awayTeam || '';

  if (!home || !away) {
    return { id: matchId, success: false, error: 'Missing homeTeam/awayTeam' };
  }

  // Default xG values (with home advantage boost 1.08x, matching Python free_fallback_service)
  const xgHome = 1.35 * 1.08;
  const xgAway = 1.15;

  // Poisson score matrix + markets
  const matrix = buildScoreMatrix(xgHome, xgAway);
  const markets = calculateMarkets(matrix);

  const pHome = Math.round(markets.home * 1000) / 10;
  const pDraw = Math.round(markets.draw * 1000) / 10;
  const pAway = Math.round(markets.away * 1000) / 10;
  const ou25 = Math.round(markets.over_25 * 1000) / 10;
  const btts = Math.round(markets.btts_yes * 1000) / 10;

  const { pick, prob, ev } = determinePick(pHome, pDraw, pAway);

  const expectedScore = `${Math.round(xgHome)} - ${Math.round(xgAway)}`;

  const predictions = {
    home_win_probability: pHome,
    draw_probability: pDraw,
    away_win_probability: pAway,
    ou_25_prob: ou25,
    btts_prob: btts,
    expected_score: expectedScore,
    prediction: pick,
    prediction_probability: prob,
    ev_score: ev,
    insufficient_data: 0,
    source: 'fallback_enricher',
    home_xg: Math.round(xgHome * 100) / 100,
    away_xg: Math.round(xgAway * 100) / 100,
  };

  return { id: matchId, success: true, ...predictions };
}

// ── Batch enrichment ──────────────────────────────────────────────

async function enrichMatchesBatch() {
  logger.info('[FALLBACK_ENRICHER] Starting batch enrichment...');
  try {
    const matches = await database.getInsufficientDataMatches();
    if (!matches || matches.length === 0) {
      logger.info('[FALLBACK_ENRICHER] No insufficient-data matches found.');
      return { enriched: 0, total: 0 };
    }

    let enriched = 0;
    for (const m of matches) {
      try {
        const result = enrichOne(m);
        if (result.success) {
          await database.updatePredictions(m.id, {
            home_win_probability: result.home_win_probability,
            draw_probability: result.draw_probability,
            away_win_probability: result.away_win_probability,
            ou_25_prob: result.ou_25_prob,
            btts_prob: result.btts_prob,
            expected_score: result.expected_score,
            prediction: result.prediction,
            prediction_probability: result.prediction_probability,
            ev_score: result.ev_score,
            insufficient_data: 0,
            home_xg: result.home_xg,
            away_xg: result.away_xg,
          });
          enriched++;
        }
      } catch (e) {
        logger.error(`[FALLBACK_ENRICHER] Error enriching ${m.id}: ${e.message}`);
      }
    }

    logger.info(`[FALLBACK_ENRICHER] Enriched ${enriched}/${matches.length} matches.`);
    return { enriched, total: matches.length };
  } catch (e) {
    logger.error(`[FALLBACK_ENRICHER] Batch failed: ${e.message}`);
    return { enriched: 0, total: 0, error: e.message };
  }
}

module.exports = { enrichOne, enrichMatchesBatch, buildScoreMatrix, calculateMarkets };
