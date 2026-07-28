/**
 * DeepFormService (V34 Elite Expansion + SoS)
 * Simulates an LSTM-like temporal weighting for historical match form.
 * More recent matches carry significantly more weight in the momentum calculation.
 * V34: Adds Strength of Schedule (SoS) adjustment and calibrated draw multipliers.
 */

class DeepFormService {
  constructor() {
    // Temporal Weights (T=0 is most recent, T=4 is oldest)
    // Sum roughly equals 1.0 (0.35 + 0.25 + 0.20 + 0.12 + 0.08)
    this.weights = [0.35, 0.25, 0.2, 0.12, 0.08]

    // Elite clubs (top leagues) get a difficulty boost when faced as opponents
    this.ELITE_CLUBS = new Set([
      'manchester city',
      'manchester united',
      'liverpool',
      'arsenal',
      'chelsea',
      'tottenham',
      'real madrid',
      'barcelona',
      'atletico madrid',
      'sevilla',
      'bayern munich',
      'dortmund',
      'leverkusen',
      'juventus',
      'inter milan',
      'ac milan',
      'napoli',
      'paris saint-germain',
      'marseille',
      'lyon',
      'psv eindhoven',
      'ajax',
      'porto',
      'benfica',
      'sporting cp',
      'galatasaray',
      'fenerbahce',
      'al ahly',
      'al hilal',
      'al ittihad',
    ])

    // League average goals per match (used for normalization)
    this.LEAGUE_AVG_GOALS = {
      'premier league': 2.7,
      'la liga': 2.5,
      bundesliga: 3.0,
      'serie a': 2.6,
      'ligue 1': 2.4,
      eredivisie: 3.1,
      'super lig': 2.8,
      eredivisie: 3.1,
      'primeira liga': 2.5,
      'champions league': 2.8,
      'europa league': 2.7,
      default: 2.6,
    }
  }

  /**
   * Analyze a series of raw form events for a specific team.
   * @param {Array} events - Array of raw Sofascore past matches
   * @param {string} teamId - The targeted team ID to determine home/away perspective
   * @returns {Object} Deep form metrics
   */
  analyzeForm(events, teamId) {
    if (!Array.isArray(events) || events.length === 0) {
      return {
        form_rating: 50,
        offensive_momentum: 50,
        defensive_stability: 50,
        strength_of_schedule: 50,
        trend: 'Stable',
        trend_vector: 0,
      }
    }

    const tid = String(teamId)

    let weightedPoints = 0
    let weightedGoalsFor = 0
    let weightedGoalsAgainst = 0
    let weightedXgFor = 0
    let weightedXgAgainst = 0
    let totalWeight = 0

    // SoS tracking
    let opponentStrengthSum = 0
    let opponentCount = 0

    // Arrays to detect trend direction
    const formTrend = []

    // Events are usually sorted newest to oldest. We process up to 5 events.
    const recentEvents = events.slice(0, 5)

    recentEvents.forEach((ev, index) => {
      const w = this.weights[index] || 0.05 // Fallback for matches beyond 5
      totalWeight += w

      const isHome = String(ev.homeTeam?.id) === tid

      // Goals
      const gs = isHome
        ? (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0)
        : (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0)
      const gc = isHome
        ? (ev.awayScore?.current ?? ev.awayScore?.normaltime ?? 0)
        : (ev.homeScore?.current ?? ev.homeScore?.normaltime ?? 0)

      // [VENUE WEIGHTING] Calibrated multipliers
      // Away wins are harder, but not as extreme as before
      const VENUE_MULT = isHome ? 0.95 : 1.2
      // Draw at home is slightly penalized (expected to win), away draw is neutral
      const DRAW_MULT = isHome ? 0.9 : 1.1

      // Points with Venue Multiplier
      let pts = 0
      if (gs > gc) pts = 3 * VENUE_MULT
      else if (gs === gc) pts = 1 * DRAW_MULT

      // Optional xG
      const xgS = isHome
        ? (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gs)
        : (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gs)
      const xgC = isHome
        ? (ev.awayXg ?? ev.awayScore?.expectedGoals ?? gc)
        : (ev.homeXg ?? ev.homeScore?.expectedGoals ?? gc)

      weightedPoints += pts * w
      weightedGoalsFor += gs * w * (isHome ? 1.0 : 1.05) // Slight bonus for away goals
      weightedGoalsAgainst += gc * w * (isHome ? 1.05 : 1.0) // Slight penalty for conceding at home
      weightedXgFor += xgS * w
      weightedXgAgainst += xgC * w

      // Strength of Schedule: estimate opponent quality
      const opponentName = isHome
        ? (ev.awayTeam?.name || '').toLowerCase()
        : (ev.homeTeam?.name || '').toLowerCase()
      const isEliteOpponent = this.ELITE_CLUBS.has(opponentName)
      const oppRank = ev.opponentRank || null

      // Estimate opponent strength: elite clubs = 85, ranked = 70, unknown = 50
      let oppStrength = 50
      if (isEliteOpponent) oppStrength = 85
      else if (oppRank && oppRank <= 20) oppStrength = 80
      else if (oppRank && oppRank <= 50) oppStrength = 65

      // Results against strong opponents are weighted more
      const resultMultiplier = gs > gc ? 1.15 : gs === gc ? 1.05 : 0.9
      opponentStrengthSum += oppStrength * w * resultMultiplier
      opponentCount += w

      // Store raw points for trend detection
      formTrend.push(pts)
    })

    // Normalize (in case totalWeight isn't exactly 1 due to < 5 matches)
    if (totalWeight > 0) {
      weightedPoints /= totalWeight
      weightedGoalsFor /= totalWeight
      weightedGoalsAgainst /= totalWeight
      weightedXgFor /= totalWeight
      weightedXgAgainst /= totalWeight
    }

    // Calculate Ratings (0-100 scale)
    // Max weighted points is 3. So (Points / 3) * 100 is base rating.
    let form_rating = (weightedPoints / 3) * 100

    // Offensive Momentum: Base 35. Each weighted goal > 1 adds ~12 pts.
    let offensive_momentum = 35 + weightedXgFor * 22 + weightedGoalsFor * 12

    // Defensive Stability: Base 85. Each expected goal against drops it by 18.
    let defensive_stability = 85 - weightedXgAgainst * 18 - weightedGoalsAgainst * 9

    // Strength of Schedule (0-100)
    const strength_of_schedule =
      opponentCount > 0 ? Math.min(100, Math.max(0, opponentStrengthSum / opponentCount)) : 50

    // SoS-adjusted form rating: boost if schedule was hard, penalize if easy
    const sosAdjustment = (strength_of_schedule - 50) * 0.08 // +/- 4 pts max
    form_rating = form_rating + sosAdjustment

    // Bound to 0-100
    form_rating = Math.max(0, Math.min(100, form_rating))
    offensive_momentum = Math.max(0, Math.min(100, offensive_momentum))
    defensive_stability = Math.max(0, Math.min(100, defensive_stability))

    // Detect Trend (comparing newest 2 matches vs oldest 3)
    let trend = 'Stable'
    let trend_vector = 0

    if (formTrend.length >= 4) {
      const recentAvg = (formTrend[0] + formTrend[1]) / 2
      const pastAvg = (formTrend[2] + formTrend[3]) / 2
      trend_vector = recentAvg - pastAvg // Positive means improving

      if (trend_vector > 0.8) trend = 'On Fire'
      else if (trend_vector > 0.3) trend = 'Improving'
      else if (trend_vector < -0.8) trend = 'Collapsing'
      else if (trend_vector < -0.3) trend = 'Declining'
    }

    return {
      form_rating: Math.round(form_rating),
      offensive_momentum: Math.round(offensive_momentum),
      defensive_stability: Math.round(defensive_stability),
      strength_of_schedule: Math.round(strength_of_schedule),
      trend,
      trend_vector: +trend_vector.toFixed(2),
      raw_weighted_pts: +weightedPoints.toFixed(2),
    }
  }

  /**
   * Compute the full Form Context for a match given both teams' metrics.
   */
  evaluateMatchForm(homeRawEvents, awayRawEvents, homeTeamId, awayTeamId) {
    const homeDeep = this.analyzeForm(homeRawEvents, homeTeamId)
    const awayDeep = this.analyzeForm(awayRawEvents, awayTeamId)

    // Calculate Form Differential (SoS-adjusted)
    const form_diff = homeDeep.form_rating - awayDeep.form_rating

    // Synergy (e.g. High Offense vs Low Defense)
    const home_attack_advantage = homeDeep.offensive_momentum - awayDeep.defensive_stability
    const away_attack_advantage = awayDeep.offensive_momentum - homeDeep.defensive_stability

    // SoS differential: who had the harder road?
    const sos_diff = homeDeep.strength_of_schedule - awayDeep.strength_of_schedule

    return {
      home: homeDeep,
      away: awayDeep,
      form_diff: Math.round(form_diff),
      home_attack_advantage: Math.round(home_attack_advantage),
      away_attack_advantage: Math.round(away_attack_advantage),
      sos_diff: Math.round(sos_diff),
    }
  }
}

module.exports = new DeepFormService()
