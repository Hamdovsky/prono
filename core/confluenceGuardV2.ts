// @ts-nocheck
/**
 * confluenceGuardV2.js — Adaptive Veto Shield with Historical Accuracy Tracking
 *
 * Tracks prediction accuracy per league, per model, per confidence band.
 * Uses Bayesian updating to dynamically adjust veto thresholds.
 *
 * Remplace le veto statique par un système adaptatif :
 *   - Si XGBoost est précis sur cette ligue → poids fort
 *   - Si Poisson est meilleur → poids fort
 *   - Si la confiance est haute mais la ligue est instable → veto
 *   - Track le Brier score en temps réel pour chaque modèle
 */
import {  query  } from './pg_connector'
import logger from './logger'

const TRACKING_KEY = 'confluence_accuracy'

class ConfluenceGuardV2 {
  constructor() {
    this.accuracy = {
      byLeague: {}, // league -> { total, correct, brierSum, modelBreakdown: { xgb: {...}, poisson: {...} } }
      byConfidence: {}, // confidenceBand -> { total, correct }
      byModel: {}, // modelName -> { total, correct }
      global: { total: 0, correct: 0, brierSum: 0 },
    }
    this._loaded = false
  }

  async load() {
    if (this._loaded) return
    try {
      const cache = global[TRACKING_KEY]
      if (cache) {
        Object.assign(this.accuracy, cache)
        this._loaded = true
        return
      }
    } catch (_) {}
    this._loaded = true
  }

  save() {
    try {
      global[TRACKING_KEY] = JSON.parse(JSON.stringify(this.accuracy))
    } catch (_) {}
  }

  /**
   * Enregistrer le résultat d'une prédiction pour améliorer le veto futur
   */
  recordOutcome(match, prediction, actualOutcome) {
    const league = (match.league || 'Unknown').toLowerCase()
    const p_h = prediction.home_win_probability || 0.33
    const p_d = prediction.draw_probability || 0.34
    const p_a = prediction.away_win_probability || 0.33
    const p_h_xgb = prediction.xgboost_probs_h || p_h
    const p_d_xgb = prediction.xgboost_probs_d || p_d
    const p_a_xgb = prediction.xgboost_probs_a || p_a
    const confidence = prediction.surgical_confidence || 50

    // One-hot actual outcome
    const actualVec =
      actualOutcome === 'home' ? [1, 0, 0] : actualOutcome === 'draw' ? [0, 1, 0] : [0, 0, 1]
    const predVec = [p_h, p_d, p_a]
    const xgbVec = [p_h_xgb, p_d_xgb, p_a_xgb]

    const brier = actualVec.reduce((s, a, i) => s + (a - predVec[i]) ** 2, 0)
    const brierXgb = actualVec.reduce((s, a, i) => s + (a - xgbVec[i]) ** 2, 0)

    const correct = predVec.indexOf(Math.max(...predVec)) === actualVec.indexOf(1) ? 1 : 0
    const correctXgb = xgbVec.indexOf(Math.max(...xgbVec)) === actualVec.indexOf(1) ? 1 : 0

    // Global
    this.accuracy.global.total++
    this.accuracy.global.correct += correct
    this.accuracy.global.brierSum += brier

    // By league
    if (!this.accuracy.byLeague[league]) {
      this.accuracy.byLeague[league] = {
        total: 0,
        correct: 0,
        brierSum: 0,
        modelBreakdown: { xgb: { total: 0, correct: 0 }, poisson: { total: 0, correct: 0 } },
      }
    }
    const l = this.accuracy.byLeague[league]
    l.total++
    l.correct += correct
    l.brierSum += brier
    if (
      prediction.ai_source &&
      (prediction.ai_source.includes('XGB') || prediction.ai_source.includes('Titanium'))
    ) {
      l.modelBreakdown.xgb.total++
      l.modelBreakdown.xgb.correct += correctXgb
    } else {
      l.modelBreakdown.poisson.total++
      l.modelBreakdown.poisson.correct += correct
    }

    // By confidence band
    const band = Math.floor(confidence / 10) * 10
    if (!this.accuracy.byConfidence[band]) {
      this.accuracy.byConfidence[band] = { total: 0, correct: 0 }
    }
    this.accuracy.byConfidence[band].total++
    this.accuracy.byConfidence[band].correct += correct

    this.save()
  }

  /**
   * Calculer un veto adaptatif basé sur la précision historique de cette ligue
   * Returns: { veto: boolean, reason: string, adjustedConfidence: number }
   */
  evaluate(match, prediction) {
    const league = (match.league || 'Unknown').toLowerCase()
    const confidence = prediction.surgical_confidence || 50
    const result = { veto: false, reason: '', adjustedConfidence: confidence, adjustments: [] }

    // Charger la précision historique
    const leagueStats = this.accuracy.byLeague[league]
    const globalStats = this.accuracy.global

    // 1. Si on a des stats sur cette ligue, ajuster selon la précision réelle
    if (leagueStats && leagueStats.total >= 10) {
      const leagueAccuracy = leagueStats.correct / leagueStats.total
      const globalAccuracy = globalStats.total > 0 ? globalStats.correct / globalStats.total : 0.5
      const avgBrier = leagueStats.brierSum / leagueStats.total

      // Si la ligue est significativement moins précise que la moyenne globale
      if (leagueAccuracy < globalAccuracy - 0.1 && leagueAccuracy < 0.45) {
        const penalty = (globalAccuracy - leagueAccuracy) * 2
        result.adjustedConfidence = Math.max(0, confidence - penalty * 100)
        result.adjustments.push(
          `league_underperformance: ${(leagueAccuracy * 100).toFixed(0)}% vs global ${(globalAccuracy * 100).toFixed(0)}%`
        )
      }

      // Bonus si la ligue est très précise
      if (leagueAccuracy > globalAccuracy + 0.1 && leagueAccuracy > 0.55) {
        const bonus = (leagueAccuracy - globalAccuracy) * 50
        result.adjustedConfidence = Math.min(100, (result.adjustedConfidence || confidence) + bonus)
        result.adjustments.push(`league_overperformance: ${(leagueAccuracy * 100).toFixed(0)}%`)
      }

      // Brier score check
      if (avgBrier > 0.25) {
        result.adjustedConfidence *= 0.8
        result.adjustments.push(`high_brier: ${avgBrier.toFixed(3)}`)
      }

      // Veto si la précision est catastrophique
      if (leagueAccuracy < 0.3 && leagueStats.total >= 20) {
        result.veto = true
        result.reason = `LEAGUE_ACCURACY_TOO_LOW: ${(leagueAccuracy * 100).toFixed(0)}% over ${leagueStats.total} matches`
        return result
      }
    }

    // 2. Vérifier le bandeau de confiance
    const band = Math.floor(confidence / 10) * 10
    const bandStats = this.accuracy.byConfidence[band]
    if (bandStats && bandStats.total >= 20) {
      const bandAccuracy = bandStats.correct / bandStats.total
      // Si la confiance est haute mais la précision réelle est basse
      if (confidence >= 70 && bandAccuracy < 0.55) {
        result.adjustedConfidence = Math.min(confidence, bandAccuracy * 100)
        result.adjustments.push(
          `confidence_miscalibration: ${band}% band = ${(bandAccuracy * 100).toFixed(0)}% actual`
        )
      }
    }

    // 3. Veto Shield pour les cas extrêmes
    if (result.adjustedConfidence < 45) {
      result.veto = true
      result.reason =
        result.reason ||
        `CONFIDENCE_TOO_LOW: ${result.adjustedConfidence.toFixed(0)}% after adjustments`
    }

    // 4. SMART MONEY CHECK: si odds bougent contre nous
    const oddsDropH = parseFloat(match.odds_drop_home || 0)
    const oddsDropA = parseFloat(match.odds_drop_away || 0)
    if (oddsDropH > 8 && prediction.verdict === 'Home') {
      result.adjustedConfidence *= 0.7
      result.adjustments.push(`smart_money_against: odds_drop_home=${oddsDropH}%`)
    }
    if (oddsDropA > 8 && prediction.verdict === 'Away') {
      result.adjustedConfidence *= 0.7
      result.adjustments.push(`smart_money_against: odds_drop_away=${oddsDropA}%`)
    }

    // 5. Market volume check
    const liquidity = parseFloat(match.liquidity_index || match.market_volume || 50000)
    if (liquidity < 10000 && confidence > 70) {
      // Low liquidity + high confidence = danger (marché manipulable)
      result.adjustedConfidence *= 0.85
      result.adjustments.push(`low_liquidity: ${liquidity.toFixed(0)}€`)
    }

    return result
  }

  /**
   * Obtenir la précision actuelle par ligue
   */
  getLeagueAccuracy(league) {
    const stats = this.accuracy.byLeague[(league || '').toLowerCase()]
    if (!stats || stats.total === 0) return null
    return {
      total: stats.total,
      accuracy: round(stats.correct / stats.total, 3),
      avgBrier: round(stats.brierSum / stats.total, 4),
      xgbAccuracy:
        stats.modelBreakdown.xgb.total > 0
          ? round(stats.modelBreakdown.xgb.correct / stats.modelBreakdown.xgb.total, 3)
          : null,
      poissonAccuracy:
        stats.modelBreakdown.poisson.total > 0
          ? round(stats.modelBreakdown.poisson.correct / stats.modelBreakdown.poisson.total, 3)
          : null,
    }
  }

  /**
   * Rapport complet
   */
  getReport() {
    const g = this.accuracy.global
    const topLeagues = Object.entries(this.accuracy.byLeague)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 20)
      .map(([name, s]) => ({
        league: name,
        total: s.total,
        accuracy: round(s.correct / s.total, 3),
        avgBrier: round(s.brierSum / s.total, 4),
      }))

    return {
      global: {
        total: g.total,
        correct: g.correct,
        accuracy: g.total > 0 ? round(g.correct / g.total, 4) : 0,
        avgBrier: g.total > 0 ? round(g.brierSum / g.total, 4) : 0,
      },
      topLeagues,
      byConfidence: Object.entries(this.accuracy.byConfidence)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .map(([band, s]) => ({
          confidenceBand: `${band}-${parseInt(band) + 9}%`,
          total: s.total,
          accuracy: round(s.correct / s.total, 3),
        })),
    }
  }
}

function round(v, d) {
  if (v == null || isNaN(v)) return 0
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

export = new ConfluenceGuardV2()
