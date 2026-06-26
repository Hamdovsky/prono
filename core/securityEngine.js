const logger = require('./logger');

const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // 1 req/sec average

// NOTE: rateLimits est en mémoire (Map). Sur Render free tier, les compteurs
// sont perdus à chaque restart. Pour une persistence Redis, remplacer par:
//   const redis = require('ioredis')
//   const key = `ratelimit:${ip}`
//   const count = await redis.incr(key)
//   await redis.expire(key, 60)

class SecurityEngine {
    constructor() {
        this.rateLimits = new Map();
    }

    checkRateLimit(ip) {
        // 🛡️ [WHITELIST] Allow Localhost Unrestricted
        if (ip.includes('127.0.0.1') || ip.includes('::1') || ip === '::ffff:127.0.0.1') {
            return true;
        }

        const now = Date.now();
        if (!this.rateLimits.has(ip)) {
            this.rateLimits.set(ip, [now]);
            return true;
        }

        const timestamps = this.rateLimits.get(ip).filter(ts => now - ts < RATE_LIMIT_WINDOW);
        if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
            return false;
        }

        timestamps.push(now);
        this.rateLimits.set(ip, timestamps);
        return true;
    }

    middleware(req, res, next) {
        const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
        if (!this.checkRateLimit(ip)) {
            logger.warn(`🚫 [SECURITY] Rate limit exceeded for IP: ${ip}`);
            return res.status(429).json({ error: 'Too Many Requests' });
        }
        next();
    }

    /**
     * 🛡️ [AUTHENTICATION] Verify Bearer Token for sensitive operations
     */
    /**
     * 🛡️ [CSRF] Origin validation for browser-based requests
     */
    validateOrigin(req, res, next) {
      const skipPaths = ['/health', '/metrics', '/api/health']
      if (skipPaths.includes(req.path)) return next()
      if (req.method === 'GET' || req.method === 'HEAD') return next()
      if (req.headers['x-api-key'] || req.headers.authorization) return next()
      const origin = req.headers.origin || req.headers.referer || ''
      const allowed = [
        'https://prono-k6gc.onrender.com',
        'http://localhost:3001',
        'http://localhost:5173',
        'capacitor://',
      ]
      if (origin && !allowed.some(a => origin.startsWith(a))) {
        logger.warn(`[SECURITY] Origin refusée: ${origin}`)
        return res.status(403).json({ error: 'Origin not allowed' })
      }
      next()
    }

    authenticate(req, res, next) {
        const authHeader = req.headers.authorization;
        const secretKey = process.env.API_SECRET_KEY;
        if (!secretKey) {
            logger.error('[SECURITY] API_SECRET_KEY is not defined in .env');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            logger.warn(`🚫 [SECURITY] Unauthorized attempt to ${req.url} from ${req.ip}`);
            return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
        }

        const token = authHeader.split(' ')[1];
        if (token !== secretKey) {
            logger.warn(`🚫 [SECURITY] Invalid token attempt from ${req.ip}`);
            return res.status(403).json({ error: 'Forbidden: Invalid security token' });
        }

        next();
    }

    handleProtocolMismatch(err, socket) {
        if (err.code === 'HPE_INVALID_METHOD' || err.code === 'ECONNRESET') {
            const remote = socket.remoteAddress || 'unknown';
            logger.warn(`🛑 [SECURITY] Protocol Mismatch/Abrupt Reset from ${remote}: ${err.message}`);
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nThis is an HTTP server. Please do NOT use HTTPS.');
        } else {
            socket.destroy(err);
        }
    }
}

module.exports = new SecurityEngine();
