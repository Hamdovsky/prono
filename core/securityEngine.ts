// @ts-nocheck
import logger from './logger'

import rateLimit from 'express-rate-limit'

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests' },
  skip: (req) => req.ip && (req.ip.includes('127.0.0.1') || req.ip === '::ffff:127.0.0.1'),
})

// Stricter limiter for expensive compute endpoints (predict, re-enrich)
const predictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Prediction rate limit exceeded (15/min)' },
  skip: (req) => req.ip && (req.ip.includes('127.0.0.1') || req.ip === '::ffff:127.0.0.1'),
})

// Limiter for write/seed endpoints (very restrictive)
const writeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Write rate limit exceeded (10/5min)' },
  skip: (req) => req.ip && (req.ip.includes('127.0.0.1') || req.ip === '::ffff:127.0.0.1'),
})

class SecurityEngine {
  constructor() {}

  middleware(req, res, next) {
    apiLimiter(req, res, next)
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
      'https://prono-k6gc-rxjf.onrender.com',
      'http://localhost:3001',
      'http://localhost:5173',
      'capacitor://',
    ]
    if (origin && !allowed.some((a) => origin.startsWith(a))) {
      logger.warn(`[SECURITY] Origin refusée: ${origin}`)
      return res.status(403).json({ error: 'Origin not allowed' })
    }
    next()
  }

  authenticate(req, res, next) {
    const authHeader = req.headers.authorization
    const secretKey = process.env.API_SECRET_KEY
    if (!secretKey) {
      logger.error('[SECURITY] API_SECRET_KEY is not defined in .env')
      return res.status(500).json({ error: 'Server configuration error' })
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(`🚫 [SECURITY] Unauthorized attempt to ${req.url} from ${req.ip}`)
      return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' })
    }

    const token = authHeader.split(' ')[1]
    if (token !== secretKey) {
      logger.warn(`🚫 [SECURITY] Invalid token attempt from ${req.ip}`)
      return res.status(403).json({ error: 'Forbidden: Invalid security token' })
    }

    next()
  }

  handleProtocolMismatch(err, socket) {
    if (err.code === 'HPE_INVALID_METHOD' || err.code === 'ECONNRESET') {
      const remote = socket.remoteAddress || 'unknown'
      logger.warn(`🛑 [SECURITY] Protocol Mismatch/Abrupt Reset from ${remote}: ${err.message}`)
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nThis is an HTTP server. Please do NOT use HTTPS.'
      )
    } else {
      socket.destroy(err)
    }
  }
}

const engine = new SecurityEngine()
;(engine as Record<string, unknown>).predictLimiter = predictLimiter
;(engine as Record<string, unknown>).writeLimiter = writeLimiter
export = engine
