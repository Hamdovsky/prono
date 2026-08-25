/**
 * oddsMovementAnalyzer.js — Real-time Sharp Money Detection Engine
 *
 * Analyse les mouvements de cotes en temps réel pour détecter :
 *   - Smart money (gros mouvements directionnels)
 *   - Steam moves (mouvements rapides et soutenus)
 *   - Reverse line movement (public vs sharp)
 *   - Arbitrage opportunities
 *   - Liquidity money flow
 *
 * Sources : odds mouvement 24h, 1h, temps réel via WebSocket
 */
const logger = require('../core/logger')

class OddsMovementAnalyzer {
  constructor() {
    this.baselines = new Map() // matchId -> { home_open, draw_open, away_open, timestamp }
    this.sharpSignals = new Map()
  }

  /**
   * Initialiser la baseline d'un match
   */
  setBaseline(match) {
    const id = match.id || `${match.homeTeam}_${match.awayTeam}_${match.date}`
    this.baselines.set(id, {
      home_open: parseFloat(match.odds_home_open || match.odds_home || 2.0),
      draw_open: parseFloat(match.odds_draw_open || match.odds_draw || 3.2),
      away_open: parseFloat(match.odds_away_open || match.odds_away || 2.0),
      timestamp: Date.now(),
      home_min: parseFloat(match.odds_home || 2.0),
      home_max: parseFloat(match.odds_home || 2.0),
      away_min: parseFloat(match.odds_away || 2.0),
      away_max: parseFloat(match.odds_away || 2.0),
      samples: 1,
    })
    return id
  }

  /**
   * Mettre à jour avec les cotes actuelles
   */
  updateOdds(matchId, oddsHome, oddsDraw, oddsAway) {
    const baseline = this.baselines.get(matchId)
    if (!baseline) return null

    baseline.samples++

    // Mettre à jour min/max
    if (oddsHome < baseline.home_min) baseline.home_min = oddsHome
    if (oddsHome > baseline.home_max) baseline.home_max = oddsHome
    if (oddsAway < baseline.away_min) baseline.away_min = oddsAway
    if (oddsAway > baseline.away_max) baseline.away_max = oddsAway

    const homeOpen = baseline.home_open
    const awayOpen = baseline.away_open

    // Calculer les changements en pourcentage
    const homeChange = ((oddsHome - homeOpen) / homeOpen) * 100
    const awayChange = ((oddsAway - awayOpen) / awayOpen) * 100
    const drawChange =
      oddsDraw && baseline.draw_open
        ? ((oddsDraw - baseline.draw_open) / baseline.draw_open) * 100
        : 0

    // Détection des signaux
    const signals = []

    // 1. Sharp money : mouvement > 10% en faveur d'un côté
    if (homeChange < -10) {
      const rating = Math.min(1, Math.abs(homeChange) / 30)
      signals.push({
        type: 'SHARP_HOME',
        direction: 'home',
        change: homeChange,
        rating,
        description: `Sharp money on Home (${homeChange.toFixed(1)}%)`,
      })
    }
    if (awayChange < -10) {
      const rating = Math.min(1, Math.abs(awayChange) / 30)
      signals.push({
        type: 'SHARP_AWAY',
        direction: 'away',
        change: awayChange,
        rating,
        description: `Sharp money on Away (${awayChange.toFixed(1)}%)`,
      })
    }

    // 2. Steam move : mouvement rapide ET soutenu (bidirectional: HOME + AWAY)
    if (baseline.samples > 3) {
      if (oddsHome / homeOpen < 0.95) {
        const velocity = Math.abs(homeChange) / baseline.samples
        if (velocity > 1.5) {
          signals.push({
            type: 'STEAM_HOME',
            direction: 'home',
            velocity,
            rating: Math.min(1, velocity / 5),
            description: `Steam move detected on Home (velocity: ${velocity.toFixed(1)}%/sample)`,
          })
        }
      }
      if (oddsAway / awayOpen < 0.95) {
        const velocity = Math.abs(awayChange) / baseline.samples
        if (velocity > 1.5) {
          signals.push({
            type: 'STEAM_AWAY',
            direction: 'away',
            velocity,
            rating: Math.min(1, velocity / 5),
            description: `Steam move detected on Away (velocity: ${velocity.toFixed(1)}%/sample)`,
          })
        }
      }
    }

    // 3. Reverse line movement : public massé sur un côté mais odds bougent dans l'autre sens
    const publicPct = this._estimatePublicPercentage(oddsHome, oddsAway)
    if (publicPct.home > 60 && homeChange > 0) {
      signals.push({
        type: 'REVERSE_HOME',
        direction: 'home',
        publicPct: publicPct.home,
        description: `Reverse line: ${publicPct.home.toFixed(0)}% public on Home but odds drifting out`,
        rating: 0.7,
      })
    }
    if (publicPct.away > 60 && awayChange > 0) {
      signals.push({
        type: 'REVERSE_AWAY',
        direction: 'away',
        publicPct: publicPct.away,
        description: `Reverse line: ${publicPct.away.toFixed(0)}% public on Away but odds drifting out`,
        rating: 0.7,
      })
    }

    // 4. Arbitrage detection
    if (oddsDraw) {
      const arbPct = 1 / oddsHome + 1 / oddsDraw + 1 / oddsAway
      if (arbPct < 1.0) {
        signals.push({
          type: 'ARBITRAGE',
          arbPct: round((1 - arbPct) * 100, 2),
          description: `Arbitrage opportunity: ${round((1 - arbPct) * 100, 2)}%`,
          rating: 1.0,
        })
      }
    }

    // 5. Odds acceleration (changement dans la dernière heure) — bidirectional
    const timeSinceOpen = Date.now() - baseline.timestamp
    const hoursSinceOpen = timeSinceOpen / (1000 * 60 * 60)
    if (hoursSinceOpen > 1) {
      const homeHourlyVelocity = Math.abs(homeChange) / Math.max(1, hoursSinceOpen)
      if (homeHourlyVelocity > 5 && homeChange < 0) {
        signals.push({
          type: 'ACCELERATION_HOME',
          direction: 'home',
          hourlyVelocity: homeHourlyVelocity,
          rating: Math.min(1, homeHourlyVelocity / 15),
          description: `Odds accelerating: ${homeHourlyVelocity.toFixed(1)}%/hr towards Home`,
        })
      }
      const awayHourlyVelocity = Math.abs(awayChange) / Math.max(1, hoursSinceOpen)
      if (awayHourlyVelocity > 5 && awayChange < 0) {
        signals.push({
          type: 'ACCELERATION_AWAY',
          direction: 'away',
          hourlyVelocity: awayHourlyVelocity,
          rating: Math.min(1, awayHourlyVelocity / 15),
          description: `Odds accelerating: ${awayHourlyVelocity.toFixed(1)}%/hr towards Away`,
        })
      }
    }

    // Weighted sharp score: steam and sharp money signals carry more weight than others
    const SIGNAL_WEIGHTS = {
      SHARP_HOME: 1.5,
      SHARP_AWAY: 1.5,
      STEAM_HOME: 1.3,
      STEAM_AWAY: 1.3,
      REVERSE_HOME: 1.0,
      REVERSE_AWAY: 1.0,
      ARBITRAGE: 0.8,
      ACCELERATION_HOME: 1.1,
      ACCELERATION_AWAY: 1.1,
    }
    let weightedSum = 0
    let totalWeight = 0
    for (const sig of signals) {
      const w = SIGNAL_WEIGHTS[sig.type] || 0.5
      weightedSum += (sig.rating || 0.5) * w
      totalWeight += w
    }
    const sharpScore = totalWeight > 0 ? weightedSum / totalWeight : 0

    const result = {
      matchId,
      current: { home: oddsHome, draw: oddsDraw, away: oddsAway },
      open: { home: homeOpen, draw: baseline.draw_open, away: awayOpen },
      changes: {
        home: round(homeChange, 1),
        draw: round(drawChange, 1),
        away: round(awayChange, 1),
      },
      signals,
      sharpScore: round(sharpScore, 2),
      interpretation: this._interpret(sharpScore, signals),
    }

    this.sharpSignals.set(matchId, result)
    return result
  }

  /**
   * Estimer le pourcentage de public sur chaque résultat
   */
  _estimatePublicPercentage(oddsHome, oddsAway) {
    // Approximation basée sur le modèle de loi de l'attraction inverse
    // Le public a tendance à masser les petits odds
    const total = 1 / oddsHome + 1 / oddsAway
    return {
      home: total > 0 ? (1 / oddsHome / total) * 100 : 50,
      away: total > 0 ? (1 / oddsAway / total) * 100 : 50,
    }
  }

  /**
   * Interpréter le signal global
   */
  _interpret(sharpScore, signals) {
    if (signals.length === 0) return 'NO_CLEAR_SIGNAL'
    if (sharpScore > 0.7) return 'STRONG_SHARP_MONEY'
    if (sharpScore > 0.4) return 'MODERATE_SHARP_MONEY'
    if (signals.some((s) => s.type === 'REVERSE_HOME' || s.type === 'REVERSE_AWAY'))
      return 'REVERSE_LINE_MOVEMENT'
    return 'WEAK_SIGNAL'
  }

  /**
   * Obtenir le signal pour un match
   */
  getSignal(matchId) {
    return this.sharpSignals.get(matchId) || null
  }

/**
    * Appliquer le signal sharp money à une prédiction
    */
  applyToPrediction(matchId, prediction) {
    const signal = this.sharpSignals.get(matchId)
    if (!signal || signal.signals.length === 0) return prediction

    const p = { ...prediction }
    let adjusted = false
    let noBet = false

    for (const sig of signal.signals) {
      if (sig.type === 'SHARP_HOME' && p.verdict !== 'Home' && sig.rating > 0.6) {
        // Sharp money va à l'encontre de notre prédiction → réduire confiance
        p.surgical_confidence = (p.surgical_confidence || 50) * 0.75
        adjusted = true
      }
      if (sig.type === 'SHARP_AWAY' && p.verdict !== 'Away' && sig.rating > 0.6) {
        p.surgical_confidence = (p.surgical_confidence || 50) * 0.75
        adjusted = true
      }
      if (sig.type === 'STEAM_HOME' && p.verdict !== 'Home' && sig.rating > 0.6) {
        p.surgical_confidence = (p.surgical_confidence || 50) * 0.8
        adjusted = true
      }
      if (sig.type === 'STEAM_AWAY' && p.verdict !== 'Away' && sig.rating > 0.6) {
        p.surgical_confidence = (p.surgical_confidence || 50) * 0.8
        adjusted = true
      }
      if (sig.type === 'ARBITRAGE' && sig.arbPct > 2) {
        // Marché inefficace → réduire confiance (peut être une erreur de data)
        p.surgical_confidence = (p.surgical_confidence || 50) * 0.9
        adjusted = true
      }
      if (sig.type === 'REVERSE_HOME' && p.verdict === 'Home') {
        // Public contre nous = bon signe (nous sommes du côté sharp)
        p.surgical_confidence = Math.min(100, (p.surgical_confidence || 50) * 1.1)
        p.is_smart_money = true
        adjusted = true
      }
      if (sig.type === 'REVERSE_AWAY' && p.verdict === 'Away') {
        p.surgical_confidence = Math.min(100, (p.surgical_confidence || 50) * 1.1)
        p.is_smart_money = true
        adjusted = true
      }

      // NO BET VETO: Sharp money strongly contradicts our verdict
      if (signal.sharpScore > 0.7) {
        const sharpDirection = signal.signals.find(s => s.direction)
        if (sharpDirection) {
          const verdictDir = p.verdict === 'Home' ? 'home' : (p.verdict === 'Away' ? 'away' : null)
          if (verdictDir && sharpDirection.direction !== verdictDir) {
            noBet = true
            p.no_bet_reason = `SHARP_CONTRADICTION: Sharp money (${signal.sharpScore.toFixed(2)}) on ${sharpDirection.direction} vs our ${verdictDir}`
            p.verdict = 'NO BET (SHARP_CONTRADICTION)'
          }
        }
      }
    }

    if (adjusted) {
      p.analysis = p.analysis || {}
      p.analysis.smart_money = signal.interpretation
      p.analysis.sharp_score = signal.sharpScore
    }

    if (noBet) {
      p.verdict = 'NO BET (SHARP_CONTRADICTION)'
      p.no_bet = true
    }

    return p
  }

  /**
   * Nettoyer les entrées plus vieilles que 48h
   */
  clean(discard = 48 * 60 * 60 * 1000) {
    const now = Date.now()
    for (const [id, baseline] of this.baselines) {
      if (now - baseline.timestamp > discard) this.baselines.delete(id)
    }
  }
}

function round(v, d) {
  if (v == null || isNaN(v)) return 0
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

module.exports = new OddsMovementAnalyzer()
