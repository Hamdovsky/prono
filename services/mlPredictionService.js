const pythonService = require('../core/pythonService');
const logger = require('../core/logger');
const { getCache, setCache } = require('../core/redisClient');

// TTL in seconds for Redis (3 minutes)
const PREDICTION_CACHE_TTL_SEC = 3 * 60;

class MLPredictionService {
    constructor() {
        // Still keep in-flight deduplication in memory (not worth storing in Redis)
        this.predictionQueue = new Map();
    }

    async getMLPrediction(match) {
        const matchId = match.id || `${match.homeTeam}_${match.awayTeam}`;
        const cacheKey = `ml_prediction:${matchId}`;

        // 1. Check Redis cache first (persists across restarts)
        const cached = await getCache(cacheKey);
        if (cached) {
            logger.debug(`⚡ [ML Cache] HIT for ${matchId}`);
            return cached;
        }

        // 2. De-duplication: If a request is already in-flight, wait for it
        if (this.predictionQueue.has(matchId)) return this.predictionQueue.get(matchId);

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
                    fullData: match.fullData || match,
                    task: 'PREDICTION'
                };

                const result = await pythonService.predict(matchData);

                // Only cache genuine successes
                if (result && result.success !== false && !result.error) {
                    await setCache(cacheKey, result, PREDICTION_CACHE_TTL_SEC);
                    logger.debug(`💾 [ML Cache] STORED for ${matchId} (TTL: ${PREDICTION_CACHE_TTL_SEC}s)`);
                } else if (result && result.success === false) {
                    logger.debug(`🔵 [ML Service] Prediction rejected for ${matchId}: ${result.error || 'Low Confidence'}`);
                }
                return result;
            } catch (err) {
                logger.error(`❌ [ML Service] Python Worker Error for match ${matchId}: ${err.message}`);
                return null;
            } finally {
                this.predictionQueue.delete(matchId);
            }
        })();

        this.predictionQueue.set(matchId, promise);
        return promise;
    }

    async clearCache() {
        logger.info('🧹 [ML] Prediction cache cleared (Redis keys will expire naturally)');
    }

    getStatus() {
        return {
            queueSize: this.predictionQueue.size,
            cacheBackend: 'Redis',
            isPredicting: this.predictionQueue.size > 0
        };
    }
}

module.exports = new MLPredictionService();
