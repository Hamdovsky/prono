class PredictionService {
  constructor() {
    this.cache = new Map()
  }

  generatePredictions(match) {
    const { homeTeam, awayTeam, stats = {} } = match

    const homeTeamName = typeof homeTeam === 'object' ? homeTeam.name : homeTeam
    const awayTeamName = typeof awayTeam === 'object' ? awayTeam.name : awayTeam

    if (!homeTeamName || !awayTeamName || homeTeamName === 'Home' || awayTeamName === 'Away') {
      return null
    }

    const homeStats = this._getTeamStats(homeTeamName, homeTeam)
    const awayStats = this._getTeamStats(awayTeamName, awayTeam)

    if (!homeStats || !awayStats) return null

    const overUnder = this._predictOverUnder(homeStats, awayStats)
    const btts = this._predictBTTS(homeStats, awayStats)
    const htGoal = this._predictFirstHalfGoal(homeStats, awayStats)

    return {
      overUnder,
      btts,
      htGoal,
      stats: {
        home: homeStats,
        away: awayStats,
      },
    }
  }

  _predictOverUnder(homeStats, awayStats) {
    const avgGoals = (homeStats.avgGoals + awayStats.avgGoals) / 2
    const avgGoalsConceded = (homeStats.avgGoalsConceded + awayStats.avgGoalsConceded) / 2
    const totalAvg = (avgGoals + avgGoalsConceded) / 2

    let prediction, confidence

    if (totalAvg >= 2.8) {
      prediction = 'OVER_2_5'
      confidence = Math.min(95, Math.round(60 + (totalAvg - 2.8) * 20))
    } else if (totalAvg <= 2.2) {
      prediction = 'UNDER_2_5'
      confidence = Math.min(95, Math.round(60 + (2.2 - totalAvg) * 20))
    } else {
      prediction = totalAvg > 2.5 ? 'OVER_2_5' : 'UNDER_2_5'
      confidence = Math.round(50 + Math.abs(totalAvg - 2.5) * 10)
    }

    return {
      prediction,
      confidence,
      avgGoals: totalAvg.toFixed(2),
      reasoning: `Moyenne de ${totalAvg.toFixed(1)} buts sur les 5 derniers matchs`,
    }
  }

  _predictBTTS(homeStats, awayStats) {
    const homeBttsPercent = homeStats.bttsPercent
    const awayBttsPercent = awayStats.bttsPercent
    const avgBtts = (homeBttsPercent + awayBttsPercent) / 2

    let prediction, confidence

    if (avgBtts >= 70) {
      prediction = 'BTTS_YES'
      confidence = Math.min(95, Math.round(avgBtts))
    } else if (avgBtts <= 30) {
      prediction = 'BTTS_NO'
      confidence = Math.min(95, Math.round(100 - avgBtts))
    } else {
      prediction = avgBtts >= 50 ? 'BTTS_YES' : 'BTTS_NO'
      confidence = Math.round(50 + Math.abs(avgBtts - 50) * 0.5)
    }

    return {
      prediction,
      confidence,
      bttsPercent: avgBtts.toFixed(0),
      reasoning: `${avgBtts.toFixed(0)}% des matchs avec les 2 équipes marquant`,
    }
  }

  _predictFirstHalfGoal(homeStats, awayStats) {
    const avgHtGoals = (homeStats.avgHtGoals + awayStats.avgHtGoals) / 2
    const htGoalPercent = (homeStats.htGoalPercent + awayStats.htGoalPercent) / 2

    let prediction, confidence

    if (avgHtGoals >= 1.2 || htGoalPercent >= 75) {
      prediction = 'HT_GOAL_YES'
      confidence = Math.min(95, Math.round(60 + avgHtGoals * 15))
    } else if (avgHtGoals <= 0.6 || htGoalPercent <= 40) {
      prediction = 'HT_GOAL_NO'
      confidence = Math.min(95, Math.round(60 + (1 - avgHtGoals) * 20))
    } else {
      prediction = avgHtGoals >= 0.9 ? 'HT_GOAL_YES' : 'HT_GOAL_NO'
      confidence = Math.round(50 + Math.abs(avgHtGoals - 0.9) * 20)
    }

    return {
      prediction,
      confidence,
      avgHtGoals: avgHtGoals.toFixed(2),
      htGoalPercent: htGoalPercent.toFixed(0),
      reasoning: `Moyenne de ${avgHtGoals.toFixed(1)} buts en 1ère MT (${htGoalPercent.toFixed(0)}% des matchs)`,
    }
  }

  _getTeamStats(teamName, teamData) {
    if (
      teamData &&
      teamData.history &&
      teamData.history.lastMatches &&
      teamData.history.lastMatches.length > 0
    ) {
      return {
        teamName,
        lastMatches: teamData.history.lastMatches,
        avgGoals: parseFloat(teamData.history.avgGoals) || 1.5,
        avgGoalsConceded: parseFloat(teamData.history.avgGoalsConceded) || 1.2,
        avgHtGoals: parseFloat(teamData.history.avgHtGoals) || 0.8,
        bttsPercent: parseFloat(teamData.history.bttsPercent) || 60,
        htGoalPercent: parseFloat(teamData.history.htGoalPercent) || 70,
      }
    }

    if (this.cache.has(teamName)) {
      return this.cache.get(teamName)
    }

    return null
  }

  clearCache() {
    this.cache.clear()
  }

  generateBulkPredictions(matches) {
    return matches
      .map((match) => ({
        ...match,
        predictions: this.generatePredictions(match),
      }))
      .filter((m) => m.predictions !== null)
  }
}

const predictionService = new PredictionService()
export default predictionService
