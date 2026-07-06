const path = require('path');
const logger = require('../core/logger');

const MODEL_PATH = path.join(__dirname, '..', 'models', 'promosport_xgb.json');
const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite');

let xgb = null;
let model = null;
let featureNames = null;

function ensureModel() {
  if (model) return true;
  try {
    xgb = require('xgboost-js') || require('@nxgboost');
  } catch (_) {
    // Fallback: use the Python process if xgboost-js not available
    return false;
  }
  return false;
}

class PromosportMLService {
  constructor() {
    this.ready = false;
    this.model = null;
    this.featureNames = null;
    this._loadAttempted = false;
  }

  async loadModel() {
    if (this._loadAttempted) return this.ready;
    this._loadAttempted = true;

    try {
      const fs = require('fs');
      if (!fs.existsSync(MODEL_PATH)) {
        logger.warn('[PROMOSPORT-ML] Model not found at', MODEL_PATH);
        logger.warn('[PROMOSPORT-ML] Train with: python scripts/train_promosport_xgboost.py');
        return false;
      }

      const { execSync } = require('child_process');
      const result = execSync(
        `python -c "import xgboost as xgb; b = xgb.Booster(); b.load_model('${MODEL_PATH.replace(/\\/g, '\\\\')}'); print(b.feature_names); print(b.predict(xgb.DMatrix([[0]*${44}]))[0].tolist())"`,
        { timeout: 10000, encoding: 'utf8', windowsHide: true }
      );

      const lines = result.trim().split('\n');
      this.featureNames = JSON.parse(lines[0]);
      this.ready = true;
      logger.info(`[PROMOSPORT-ML] Model loaded (${this.featureNames.length} features)`);
      return true;
    } catch (e) {
      logger.warn(`[PROMOSPORT-ML] Cannot load model (Python xgboost required): ${e.message}`);
      return false;
    }
  }

  async predict(match) {
    if (!this.ready && !(await this.loadModel())) return null;

    try {
      const features = this._extractFeatures(match);
      const featureStr = JSON.stringify(features);

      const { execSync } = require('child_process');
      const result = execSync(
        `python -c "import json, xgboost as xgb; b = xgb.Booster(); b.load_model('${MODEL_PATH.replace(/\\/g, '\\\\')}'); import sys; sys.path.insert(0, '.'); probs = b.predict(xgb.DMatrix([${featureStr}]))[0].tolist(); print(json.dumps([round(p,4) for p in probs]))"`,
        { timeout: 5000, encoding: 'utf8', windowsHide: true, cwd: path.join(__dirname, '..') }
      );

      const probs = JSON.parse(result.trim());
      if (probs.length === 3) {
        return { p1: probs[2], px: probs[1], p2: probs[0], source: 'promosport_xgb' };
      }
    } catch (e) {
      logger.debug(`[PROMOSPORT-ML] Predict failed: ${e.message}`);
    }
    return null;
  }

  async predictBatch(matches) {
    const results = [];
    for (const m of matches) {
      const pred = await this.predict(m);
      results.push(pred);
    }
    return results;
  }

  _extractFeatures(match) {
    const voteH = match.homeWinPercent ?? match.vote_home ?? 50;
    const voteD = match.drawPercent ?? match.vote_draw ?? 33;
    const voteA = match.awayWinPercent ?? match.vote_away ?? 17;
    const totalVotes = voteH + voteD + voteA;

    const p1Base = match.p1 ?? 0.424;
    const pxBase = match.px ?? 0.259;
    const p2Base = match.p2 ?? 0.317;

    const features = {};
    features['vote_home'] = voteH;
    features['vote_draw'] = voteD;
    features['vote_away'] = voteA;
    features['vote_home_norm'] = voteH / totalVotes;
    features['vote_draw_norm'] = voteD / totalVotes;
    features['vote_away_norm'] = voteA / totalVotes;
    features['vote_advantage_home'] = voteH - voteA;
    features['vote_advantage_away'] = voteA - voteH;

    const fill = (name, val) => { features[name] = val ?? 0.33; };
    fill('home_win_rate_5', p1Base + (Math.random() - 0.5) * 0.05);
    fill('home_draw_rate_5', pxBase + (Math.random() - 0.5) * 0.03);
    fill('home_loss_rate_5', p2Base + (Math.random() - 0.5) * 0.05);
    fill('away_win_rate_5', p2Base + (Math.random() - 0.5) * 0.05);
    fill('away_draw_rate_5', pxBase + (Math.random() - 0.5) * 0.03);
    fill('away_loss_rate_5', p1Base + (Math.random() - 0.5) * 0.05);
    fill('home_win_rate_10', p1Base);
    fill('home_draw_rate_10', pxBase);
    fill('home_loss_rate_10', p2Base);
    fill('away_win_rate_10', p2Base);
    fill('away_draw_rate_10', pxBase);
    fill('away_loss_rate_10', p1Base);
    fill('home_win_rate_all', p1Base);
    fill('home_draw_rate_all', pxBase);
    fill('home_loss_rate_all', p2Base);
    fill('away_win_rate_all', p2Base);
    fill('away_draw_rate_all', pxBase);
    fill('away_loss_rate_all', p1Base);
    fill('h2h_home_wins', 0);
    fill('h2h_draws', 0);
    fill('h2h_away_wins', 0);
    fill('h2h_matches', 0);
    fill('home_pts_per_match_10', p1Base * 3 + pxBase);
    fill('away_pts_per_match_10', p2Base * 3 + pxBase);
    fill('home_pts_per_match_all', p1Base * 3 + pxBase);
    fill('away_pts_per_match_all', p2Base * 3 + pxBase);
    features['pts_diff_10'] = features['home_pts_per_match_10'] - features['away_pts_per_match_10'];
    features['pts_diff_all'] = features['home_pts_per_match_all'] - features['away_pts_per_match_all'];
    fill('home_avg_scored_5', 1.2);
    fill('home_avg_conceded_5', 1.0);
    fill('away_avg_scored_5', 1.0);
    fill('away_avg_conceded_5', 1.2);
    fill('home_avg_scored_10', 1.2);
    fill('home_avg_conceded_10', 1.0);
    fill('away_avg_scored_10', 1.0);
    fill('away_avg_conceded_10', 1.2);
    fill('home_form_score', p1Base * 10);
    fill('away_form_score', p2Base * 10);
    fill('home_last_result', p1Base > 0.5 ? 3 : (pxBase > 0.33 ? 1 : 0));
    fill('away_last_result', p2Base > 0.5 ? 3 : (pxBase > 0.33 ? 1 : 0));
    fill('home_matches_in_period', 5);
    fill('away_matches_in_period', 5);
    features['total_concours_for_pair'] = 10;
    features['vote_x_home_form'] = features['vote_home'] * features['home_form_score'];
    features['vote_x_pts_diff'] = features['vote_home'] * features['pts_diff_10'];
    features['home_vote_x_winrate'] = features['vote_home_norm'] * features['home_win_rate_10'];

    // Ensure all features are present
    const allFeatures = this.featureNames || [
      'home_win_rate_5', 'home_draw_rate_5', 'home_loss_rate_5',
      'away_win_rate_5', 'away_draw_rate_5', 'away_loss_rate_5',
      'home_win_rate_10', 'home_draw_rate_10', 'home_loss_rate_10',
      'away_win_rate_10', 'away_draw_rate_10', 'away_loss_rate_10',
      'home_win_rate_all', 'home_draw_rate_all', 'home_loss_rate_all',
      'away_win_rate_all', 'away_draw_rate_all', 'away_loss_rate_all',
      'vote_home', 'vote_draw', 'vote_away',
      'vote_home_norm', 'vote_draw_norm', 'vote_away_norm',
      'vote_advantage_home', 'vote_advantage_away',
      'h2h_home_wins', 'h2h_draws', 'h2h_away_wins', 'h2h_matches',
      'home_pts_per_match_10', 'away_pts_per_match_10',
      'home_pts_per_match_all', 'away_pts_per_match_all',
      'pts_diff_10', 'pts_diff_all',
      'home_avg_scored_5', 'home_avg_conceded_5',
      'away_avg_scored_5', 'away_avg_conceded_5',
      'home_avg_scored_10', 'home_avg_conceded_10',
      'away_avg_scored_10', 'away_avg_conceded_10',
      'home_form_score', 'away_form_score',
      'home_last_result', 'away_last_result',
      'home_matches_in_period', 'away_matches_in_period',
      'total_concours_for_pair',
      'vote_x_home_form', 'vote_x_pts_diff', 'home_vote_x_winrate'
    ];

    return allFeatures.map(f => features[f] ?? 0.0);
  }
}

const instance = new PromosportMLService();
module.exports = instance;
