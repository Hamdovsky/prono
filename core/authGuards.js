const securityEngine = require('./securityEngine')

// Garde mutualisée (audit 2026-09-10, É7) : le bypass de dev reposait sur
// `NODE_ENV !== 'production'` — un déploiement Render/Docker sans NODE_ENV se
// retrouvait sans authentification. Le contournement exige désormais un choix
// EXPLICITE `AUTH_DEV_BYPASS=1` (posé par start.bat), plus le marqueur
// d'environnement accidentel.
function devBypassAllowed() {
  return process.env.AUTH_DEV_BYPASS === '1'
}

// Render place un proxy local devant le conteneur : le trafic WEB externe
// arrive avec socket 127.0.0.1 + X-Forwarded-For. On ne fait donc confiance
// à la socket localhost QUE sans XFF (appels internes réels : worker local,
// bot, cron dans le même conteneur).
function isLocalSocket(req) {
  const ip = req.socket?.remoteAddress || ''
  const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  return local && !req.headers['x-forwarded-for']
}

const localOrAuth = (req, res, next) => {
  if (isLocalSocket(req) || devBypassAllowed()) return next()
  return securityEngine.authenticate(req, res, next)
}

const bearerToken = (req) => {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

// Données personnelles de l'utilisateur (bankroll bets) : localhost, token
// admin OU JWT valide (services/authService, /api/auth/login). Le JWT évite
// de partager le secret global d'API avec le navigateur (audit É9).
const localOrJwtOrAdmin = (req, res, next) => {
  if (isLocalSocket(req) || devBypassAllowed()) return next()
  const token = bearerToken(req)
  const secret = process.env.API_SECRET_KEY
  if (secret && token && token === secret) return next()
  if (token) {
    try {
      const authService = require('../services/authService')
      // É10 : bankroll = données du propriétaire ; seul un JWT de rôle admin
      // (1ᵉʳ compte bootstrap ou invité par l'admin) y a droit.
      const decoded = authService.verifyToken(token)
      if (decoded && decoded.role === 'admin') return next()
    } catch (_) {
      /* authService indisponible -> 401 ci-dessous */
    }
  }
  return res.status(401).json({ error: 'Unauthorized: admin token or login required' })
}

module.exports = { localOrAuth, localOrJwtOrAdmin, isLocalSocket, devBypassAllowed }
