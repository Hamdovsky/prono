const pythonService = require('../core/pythonService')
const logger = require('../core/logger')
const { getCache, setCache } = require('../core/redisClient')

// TTL in seconds for Redis (3 minutes)
const PREDICTION_CACHE_TTL_SEC = 3 * 60

class MLPredictionService {
  constructor() {
    // Still keep in-flight deduplication in memory (not worth storing in Redis)
    this.predictionQueue = new Map()
  }

  async getMLPrediction(match) {
    const matchId = match.id || `${match.homeTeam}_${match.awayTeam}`
    const cacheKey = `ml_prediction:${matchId}`

    // 1. Check Redis cache first (persists across restarts)
    const cached = await getCache(cacheKey)
    if (cached) {
      logger.debug(`⚡ [ML Cache] HIT for ${matchId}`)
      return cached
    }

    // 2. De-duplication: If a request is already in-flight, wait for it
    if (this.predictionQueue.has(matchId)) return this.predictionQueue.get(matchId)

    const promise = (async () => {
      try {
        const matchData = {
          minute: parseInt(match.minute) || 0,
          score_home: match.scoreHome || match.score?.home || 0,
          score_away: match.scoreAway || match.score?.away || 0,
          home_pressure: match.stats?.dangerousAttacks?.home || match.live_pressure || 0,
          away_pressure: match.stats?.dangerousAttacks?.away || 0,
          home_shots: match.stats?.totalShots?.home || match.shots_on_target_home || 0,
          away_shots: match.stats?.totalShots?.away || 0,
          home_corners: match.stats?.corners?.home || match.corners_home || 0,
          away_corners: match.stats?.corners?.away || 0,
          possession_home: match.stats?.possession?.home || match.possession_home || 50,
          possession_away: match.stats?.possession?.away || 50,
          weather_temp: match.weather_temp || null,
          weather_humidity: match.weather_humidity || null,
          home_form_pts: match.home_form_pts || 0,
          away_form_pts: match.away_form_pts || 0,
          odds_home: match.odds_home || null,
          odds_draw: match.odds_draw || null,
          odds_away: match.odds_away || null,
          real_markets: match.real_markets || (match.fullData && match.fullData.real_markets) || null,
          fullData: match.fullData || match,
          task: 'PREDICTION',
        }

        if (matchData.real_markets) {
          logger.debug(`[MARKET-ENGINE] real_markets forwarde a /predict (${matchData.real_markets.length} marche(s))`)
        }

        const result = await pythonService.predict(matchData)

        // Apply Confluence Guard V2 (adaptive veto shield)
        if (result && result.success) {
          try {
            const guard = require('../core/confluenceGuardV2')
            await guard.load()
            const { veto, reason, adjustedConfidence, adjustments } = guard.evaluate(match, result)
            if (veto) {
              logger.warn(`🛡️ [CONFLUENCE] VETO for ${matchId}: ${reason}`)
              result.success = false
              result.error = `CONFLUENCE_VETO: ${reason}`
              result.veto_reason = reason
            } else {
              result.surgical_confidence = adjustedConfidence
              result.confluence_adjustments = adjustments
            }
          } catch (e) {
            logger.warn(`⚠️ [CONFLUENCE] Error: ${e.message}`)
          }
        }

        // Apply odds movement sharp money analysis
        if (result && result.success) {
          try {
            const analyzer = require('./oddsMovementAnalyzer')
            const matchId2 = match.id || `${match.homeTeam}_${match.awayTeam}`
            const signal = analyzer.getSignal(matchId2)
            if (signal && signal.signals.length > 0) {
              const adjusted = analyzer.applyToPrediction(matchId2, result)
              if (adjusted !== result) {
                Object.assign(result, adjusted)
              }
            }
          } catch (e) {
            // Non-critical
          }
        }

        // Only cache genuine successes
        if (result && result.success !== false && !result.error) {
          await setCache(cacheKey, result, PREDICTION_CACHE_TTL_SEC)
          logger.debug(`💾 [ML Cache] STORED for ${matchId} (TTL: ${PREDICTION_CACHE_TTL_SEC}s)`)
        } else if (result && result.success === false) {
          logger.debug(
            `🔵 [ML Service] Prediction rejected for ${matchId}: ${result.error || 'Low Confidence'}`
          )
        }
        return result
      } catch (err) {
        logger.error(`❌ [ML Service] Python Worker Error for match ${matchId}: ${err.message}`)
        return null
      } finally {
        this.predictionQueue.delete(matchId)
      }
    })()

    this.predictionQueue.set(matchId, promise)
    return promise
  }

  async clearCache() {
    logger.info('🧹 [ML] Prediction cache cleared (Redis keys will expire naturally)')
  }

  getStatus() {
    return {
      queueSize: this.predictionQueue.size,
      cacheBackend: 'Redis',
      isPredicting: this.predictionQueue.size > 0,
    }
  }
}

module.exports = new MLPredictionService()
