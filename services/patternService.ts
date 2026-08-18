// @ts-nocheck
import fs from 'fs'
import path from 'path'
import database from '../core/database'
import logger from '../core/logger'

const WEIGHTS_FILE = path.join(__dirname, '..', 'data', 'model_weights.json')
const CACHE_MAX_AGE = 5 * 60 * 1000 // 5 minutes

// Matches arrive either as `score: {home, away}` (live) or `scoreHome/scoreAway`
// (DB rows). Normalize so pattern matching never reads undefined.
function getScorePair(match) {
  if (!match) return { home: 0, away: 0 }
  if (match.score && typeof match.score.home === 'number' && typeof match.score.away === 'number') {
    return { home: match.score.home, away: match.score.away }
  }
  const sh = match.scoreHome ?? match.score_home ?? 0
  const sa = match.scoreAway ?? match.score_away ?? 0
  return { home: parseInt(sh) || 0, away: parseInt(sa) || 0 }
}

// winning_patterns stores score as a "H-A" string (or optionally an object).
function parsePatternScore(score) {
  if (score && typeof score === 'object' && !Array.isArray(score)) {
    return { home: parseInt(score.home) || 0, away: parseInt(score.away) || 0 }
  }
  const parts = String(score || '0-0').split('-')
  return { home: parseInt(parts[0]) || 0, away: parseInt(parts[1]) || 0 }
}

class PatternService {
  constructor() {
    this.patternMatchCache = new Map()
  }

  async logWinningPattern(match) {
    try {
      const { home, away } = getScorePair(match)
      const scoreState = `${home}-${away}`
      const timePeriod = match.minute && match.minute.includes('2nd') ? '2nd_half' : '1st_half'

      // Insert into SQLite pattern history
      await database.insertPattern(match)
      logger.info(
        `📈 [PATTERN] Logged: ${match.homeTeam} vs ${match.awayTeam} [${scoreState} @ ${timePeriod}]`
      )
    } catch (e) {
      logger.error(`❌ [PATTERN] Failed to log pattern: ${e.message}`)
    }
  }

  async analyze(match) {
    try {
      const boosted = await this.applyVVIPBoost(match)
      if (boosted.isVVIP) {
        return { match: true, probability: 0.85, ...boosted.vvipDetails }
      }
      return { match: false, probability: 0 }
    } catch (e) {
      logger.error(`❌ [PATTERN] analyze error: ${e.message}`)
      return { match: false, probability: 0 }
    }
  }

  async applyVVIPBoost(match) {
    try {
      const patterns = await database.getAllPatterns(50)
      if (!Array.isArray(patterns) || patterns.length < 5) return match

      let weights = { vvip_boost_multiplier: 1.12, pressure_baseline: 60 }
      if (fs.existsSync(WEIGHTS_FILE)) {
        try {
          const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE))
          weights = data.coefficients || weights
        } catch (e) {
          /* use default */
        }
      }

      const { home: curHome, away: curAway } = getScorePair(match)
      const currentScoreState = `${curHome}-${curAway}`
      const currentTimePeriod =
        match.minute && match.minute.includes('2nd') ? '2nd_half' : '1st_half'
      const currentPressure = match.stats?.pressure?.home || 0

      const cacheKey = `${match.league}_${currentScoreState}_${currentTimePeriod}_${currentPressure}_${match.winProb}`
      if (this.patternMatchCache.has(cacheKey)) {
        const cached = this.patternMatchCache.get(cacheKey)
        if (Date.now() - cached.timestamp < CACHE_MAX_AGE) return cached.result
      }

      // Multi-dimensional pattern matching logic
      const matchedPatterns = patterns
        .map((p) => {
          const patternAge =
            (Date.now() - new Date(p.timestamp).getTime()) / (1000 * 60 * 60 * 24 * 7)
          const decayFactor = Math.max(0.7, 1 - patternAge * 0.02)
          const leagueMatch = p.league === match.league ? 30 : 0
          const pScore = parsePatternScore(p.score)
          const scoreStateMatch = pScore.home === curHome && pScore.away === curAway ? 25 : 0
          const pPressure = p.stats?.pressure?.home || 0
          const pressureSimilarity = Math.abs(pPressure - currentPressure) < 15 ? 15 : 0
          const probSimilarity = Math.abs((p.winProb || 50) - (match.winProb || 50)) < 10 ? 5 : 0
          const totalScore =
            (leagueMatch + scoreStateMatch + pressureSimilarity + probSimilarity) * decayFactor
          return { pattern: p, score: totalScore, decayFactor }
        })
        .filter((m) => m.score >= 50)

      if (matchedPatterns.length >= 3) {
        const avgDecay =
          matchedPatterns.reduce((sum, m) => sum + m.decayFactor, 0) / matchedPatterns.length
        const patternStrength = Math.min(matchedPatterns.length / 10, 1)
        const baseBoost = (match.winProb || 50) * (weights.vvip_boost_multiplier - 1)
        const boost = Math.round(baseBoost * avgDecay * (1 + patternStrength * 0.3))
        const finalBoost = Math.max(5, Math.min(15, boost))

        const boostedMatch = {
          ...match,
          winProb: Math.min(99, (match.winProb || 50) + finalBoost),
          isVVIP: true,
          vvipDetails: {
            patternCount: matchedPatterns.length,
            boostAmount: finalBoost,
            confidenceDecay: avgDecay,
          },
        }

        this.patternMatchCache.set(cacheKey, { result: boostedMatch, timestamp: Date.now() })
        if (this.patternMatchCache.size > 100)
          this.patternMatchCache.delete(this.patternMatchCache.keys().next().value)
        return boostedMatch
      }
    } catch (e) {
      logger.error(`❌ [PATTERN] VVIP Boost Error: ${e.message}`)
    }
    return match
  }
}

export = new PatternService()
