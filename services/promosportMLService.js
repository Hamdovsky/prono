const path = require('path')
const Database = require('better-sqlite3')
const { execSync } = require('child_process')
const logger = require('../core/logger')
const { resolvePython } = require('../core/utils/pythonResolver')

const PYTHON = resolvePython()

const MODEL_PATH = path.join(__dirname, '..', 'models', 'promosport_xgb.json')
const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const PYTHON_SCRIPT = path.join(__dirname, '..', 'scripts', 'predict_promosport_batch.py')

class PromosportMLService {
  constructor() {
    this.ready = false
    this._attempted = false
  }

  reloadModel() {
    this._attempted = false
    this.ready = false
    return this.loadModel()
  }

  loadModel() {
    if (this._attempted) return this.ready
    this._attempted = true

    try {
      const fs = require('fs')
      if (!fs.existsSync(MODEL_PATH)) {
        logger.warn('[PROMOSPORT-ML] Model not found at', MODEL_PATH)
        return false
      }
      if (!fs.existsSync(PYTHON_SCRIPT)) {
        fs.writeFileSync(
          PYTHON_SCRIPT,
          `import json, sys, xgboost as xgb
model_path = sys.argv[1]
booster = xgb.Booster()
booster.load_model(model_path)
input_data = json.loads(sys.stdin.read())
dmatrix = xgb.DMatrix(input_data, feature_names=booster.feature_names)
probs = booster.predict(dmatrix)
print(json.dumps(probs.tolist()))
`
        )
      }

      execSync(
        `"${PYTHON}" -c "import xgboost as xgb; b=xgb.Booster(); b.load_model('${MODEL_PATH.replace(/\\/g, '\\\\')}'); print('OK')"`,
        { timeout: 5000, encoding: 'utf8', windowsHide: true }
      )

      this.ready = true
      logger.info('[PROMOSPORT-ML] Model ready')
      return true
    } catch (e) {
      logger.warn(`[PROMOSPORT-ML] Model unavailable: ${e.message}`)
      return false
    }
  }

  predictBatch(matches) {
    if (!this.ready && !this.loadModel()) return null

    const db = new Database(ARCHIVE_PATH, { readonly: true })
    const features = matches.map((m) => this._extractFeatures(m, db))
    db.close()

    try {
      const inputJson = JSON.stringify(features)
      const result = execSync(
        `"${PYTHON}" "${PYTHON_SCRIPT.replace(/\\/g, '\\\\')}" "${MODEL_PATH.replace(/\\/g, '\\\\')}"`,
        {
          input: inputJson,
          timeout: 10000,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }
      )

      const allProbs = JSON.parse(result.trim())
      return matches.map((m, i) => {
        if (!allProbs[i]) return null
        const [pAway, pDraw, pHome] = allProbs[i]
        return { p1: pHome, px: pDraw, p2: pAway, source: 'promosport_xgb' }
      })
    } catch (e) {
      logger.debug(`[PROMOSPORT-ML] Batch predict failed: ${e.message}`)
      return null
    }
  }

  predict(match) {
    const results = this.predictBatch([match])
    return results ? results[0] : null
  }

  _getTeamStats(db, team, beforeDate) {
    const params = [team, team]
    let dateFilter = ''
    if (beforeDate) {
      dateFilter = ' AND archived_at < ?'
      params.push(beforeDate)
    }

    const all = db
      .prepare(
        `
      SELECT result, score_home, score_away, homeTeam
      FROM promosport_archive
      WHERE (homeTeam = ? OR awayTeam = ?) AND result IS NOT NULL AND result != 'N' ${dateFilter}
    `
      )
      .all(...params)

    if (!all.length) return null

    let wins = 0,
      draws = 0,
      losses = 0,
      pts = 0,
      gf = 0,
      ga = 0,
      scoredCount = 0
    for (const r of all) {
      const isHome = r.homeTeam === team
      if (r.result === '1') {
        wins += isHome ? 1 : 0
        losses += isHome ? 0 : 1
        pts += isHome ? 3 : 0
      } else if (r.result === '2') {
        losses += isHome ? 1 : 0
        wins += isHome ? 0 : 1
        pts += isHome ? 0 : 3
      } else {
        draws++
        pts += 1
      }
      if (r.score_home != null) {
        gf += isHome ? r.score_home : r.score_away
        ga += isHome ? r.score_away : r.score_home
        scoredCount++
      }
    }
    const n = all.length
    return {
      n,
      wins,
      draws,
      losses,
      pts,
      gf,
      ga,
      scoredCount,
      winRate: wins / n,
      drawRate: draws / n,
      lossRate: losses / n,
      ptsPerMatch: pts / n,
      avgScored: scoredCount ? gf / scoredCount : 0.5,
      avgConceded: scoredCount ? ga / scoredCount : 0.5,
    }
  }

  _getRecentStats(db, team, limit, beforeDate) {
    const params = [team, team]
    let dateFilter = ''
    if (beforeDate) {
      dateFilter = ' AND archived_at < ?'
      params.push(beforeDate)
    }
    params.push(limit)

    const rows = db
      .prepare(
        `
      SELECT result, homeTeam, score_home, score_away
      FROM promosport_archive
      WHERE (homeTeam = ? OR awayTeam = ?) AND result IS NOT NULL AND result != 'N' ${dateFilter}
      ORDER BY archived_at DESC LIMIT ?
    `
      )
      .all(...params)

    if (!rows.length) return null

    let wins = 0,
      draws = 0,
      pts = 0,
      gf = 0,
      ga = 0,
      sc = 0,
      formScore = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const isHome = r.homeTeam === team
      let matchPts = 0
      if (r.result === '1') {
        wins += isHome ? 1 : 0
        matchPts = isHome ? 3 : 0
      } else if (r.result === '2') {
        wins += isHome ? 0 : 1
        matchPts = isHome ? 0 : 3
      } else {
        draws++
        matchPts = 1
      }
      pts += matchPts
      formScore += matchPts * (1 / (i + 1))
      if (r.score_home != null) {
        gf += isHome ? r.score_home : r.score_away
        ga += isHome ? r.score_away : r.score_home
        sc++
      }
    }
    const n = rows.length
    return {
      n,
      wins,
      draws,
      losses: n - wins - draws,
      pts,
      gf,
      ga,
      scoredCount: sc,
      winRate: wins / n,
      drawRate: draws / n,
      lossRate: (n - wins - draws) / n,
      ptsPerMatch: pts / n,
      formScore,
      lastResult: pts > 0 ? (pts > 1 ? 3 : 1) : 0,
      avgScored: sc ? gf / sc : 0.5,
      avgConceded: sc ? ga / sc : 0.5,
    }
  }

  _getH2H(db, home, away, beforeDate) {
    const params = [home, away, home, away]
    let dateFilter = ''
    if (beforeDate) {
      dateFilter = ' AND archived_at < ?'
      params.push(beforeDate)
    }

    const rows = db
      .prepare(
        `
      SELECT result FROM promosport_archive
      WHERE ((homeTeam = ? AND awayTeam = ?) OR (homeTeam = ? AND awayTeam = ?))
        AND result IS NOT NULL AND result != 'N' ${dateFilter}
    `
      )
      .all(...params)

    let hw = 0,
      d = 0,
      aw = 0
    for (const r of rows) {
      r.result === '1' ? hw++ : r.result === 'X' ? d++ : aw++
    }
    return { homeWins: hw, draws: d, awayWins: aw, total: rows.length }
  }

  _extractFeatures(match, db) {
    const f = {}
    const home = (match.homeTeam || '').toUpperCase()
    const away = (match.awayTeam || '').toUpperCase()
    const rawVoteH =
      match.publicP1 ?? match.homeWinPercent ?? match.crowdP1 ?? match.homeWinProbability ?? 50
    const rawVoteD = match.publicPX ?? match.drawPercent ?? match.drawProbability ?? 33
    const rawVoteA =
      match.publicP2 ?? match.awayWinPercent ?? match.crowdP2 ?? match.awayWinProbability ?? 17
    const voteH = rawVoteH < 1 ? rawVoteH * 100 : rawVoteH
    const voteD = rawVoteD < 1 ? rawVoteD * 100 : rawVoteD
    const voteA = rawVoteA < 1 ? rawVoteA * 100 : rawVoteA
    const totalV = voteH + voteD + voteA

    f['vote_home'] = voteH
    f['vote_draw'] = voteD
    f['vote_away'] = voteA
    f['vote_home_norm'] = totalV > 0 ? voteH / totalV : 0.5
    f['vote_draw_norm'] = totalV > 0 ? voteD / totalV : 0.33
    f['vote_away_norm'] = totalV > 0 ? voteA / totalV : 0.17
    f['vote_advantage_home'] = voteH - voteA
    f['vote_advantage_away'] = voteA - voteH

    for (const s5 of [this._getRecentStats(db, home, 5), this._getRecentStats(db, away, 5)]) {
      // handled below with prefix
    }
    for (const [team, prefix] of [
      [home, 'home'],
      [away, 'away'],
    ]) {
      const all = this._getTeamStats(db, team)
      const r5 = this._getRecentStats(db, team, 5)
      const r10 = this._getRecentStats(db, team, 10)

      for (const [s, suffix] of [
        [r5, '5'],
        [r10, '10'],
        [all, 'all'],
      ]) {
        if (s) {
          f[`${prefix}_win_rate_${suffix}`] = s.winRate
          f[`${prefix}_draw_rate_${suffix}`] = s.drawRate
          f[`${prefix}_loss_rate_${suffix}`] = s.lossRate
          f[`${prefix}_pts_per_match_${suffix}`] = s.ptsPerMatch
          f[`${prefix}_avg_scored_${suffix}`] = s.avgScored
          f[`${prefix}_avg_conceded_${suffix}`] = s.avgConceded
        } else {
          f[`${prefix}_win_rate_${suffix}`] = 0.33
          f[`${prefix}_draw_rate_${suffix}`] = 0.33
          f[`${prefix}_loss_rate_${suffix}`] = 0.33
          f[`${prefix}_pts_per_match_${suffix}`] = 1.0
          f[`${prefix}_avg_scored_${suffix}`] = 1.0
          f[`${prefix}_avg_conceded_${suffix}`] = 1.0
        }
      }

      if (r5) {
        f[`${prefix}_form_score`] = r5.formScore
        f[`${prefix}_last_result`] = r5.lastResult
      } else {
        f[`${prefix}_form_score`] = 5
        f[`${prefix}_last_result`] = 1
      }

      f[`${prefix}_matches_in_period`] = all ? all.n : 0
    }

    f['pts_diff_10'] = (f['home_pts_per_match_10'] || 1.0) - (f['away_pts_per_match_10'] || 1.0)
    f['pts_diff_all'] = (f['home_pts_per_match_all'] || 1.0) - (f['away_pts_per_match_all'] || 1.0)

    const h2h = this._getH2H(db, home, away)
    f['h2h_home_wins'] = h2h.homeWins
    f['h2h_draws'] = h2h.draws
    f['h2h_away_wins'] = h2h.awayWins
    f['h2h_matches'] = h2h.total

    f['total_concours_for_pair'] =
      (f['home_matches_in_period'] || 0) + (f['away_matches_in_period'] || 0)
    f['form_diff'] = (f['home_form_score'] || 5) - (f['away_form_score'] || 5)
    f['win_rate_diff_all'] = (f['home_win_rate_all'] || 0.33) - (f['away_win_rate_all'] || 0.33)
    f['avg_scored_diff_10'] = (f['home_avg_scored_10'] || 0.5) - (f['away_avg_scored_10'] || 0.5)
    f['avg_conceded_diff_10'] =
      (f['home_avg_conceded_10'] || 0.5) - (f['away_avg_conceded_10'] || 0.5)
    f['vote_x_home_form'] = f['vote_home'] * (f['home_form_score'] || 5)
    f['vote_x_pts_diff'] = f['vote_home'] * (f['pts_diff_10'] || 0)
    f['home_vote_x_winrate'] = f['vote_home_norm'] * (f['home_win_rate_10'] || 0.33)

    const FEATURE_NAMES = [
      'home_win_rate_5',
      'home_draw_rate_5',
      'home_loss_rate_5',
      'away_win_rate_5',
      'away_draw_rate_5',
      'away_loss_rate_5',
      'home_win_rate_10',
      'home_draw_rate_10',
      'home_loss_rate_10',
      'away_win_rate_10',
      'away_draw_rate_10',
      'away_loss_rate_10',
      'home_win_rate_all',
      'home_draw_rate_all',
      'home_loss_rate_all',
      'away_win_rate_all',
      'away_draw_rate_all',
      'away_loss_rate_all',
      'vote_home',
      'vote_draw',
      'vote_away',
      'vote_home_norm',
      'vote_draw_norm',
      'vote_away_norm',
      'vote_advantage_home',
      'vote_advantage_away',
      'h2h_home_wins',
      'h2h_draws',
      'h2h_away_wins',
      'h2h_matches',
      'home_pts_per_match_10',
      'away_pts_per_match_10',
      'home_pts_per_match_all',
      'away_pts_per_match_all',
      'pts_diff_10',
      'pts_diff_all',
      'home_avg_scored_5',
      'home_avg_conceded_5',
      'away_avg_scored_5',
      'away_avg_conceded_5',
      'home_avg_scored_10',
      'home_avg_conceded_10',
      'away_avg_scored_10',
      'away_avg_conceded_10',
      'home_form_score',
      'away_form_score',
      'home_last_result',
      'away_last_result',
      'home_matches_in_period',
      'away_matches_in_period',
      'total_concours_for_pair',
      'form_diff',
      'win_rate_diff_all',
      'avg_scored_diff_10',
      'avg_conceded_diff_10',
      'vote_x_home_form',
      'vote_x_pts_diff',
      'home_vote_x_winrate',
    ]

    return FEATURE_NAMES.map((k) => f[k] ?? 0.0)
  }
}

module.exports = new PromosportMLService()
