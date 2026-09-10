const securityEngine = require('./securityEngine')

// Garde mutualisée (audit 2026-09-10, É7) : le bypass de dev reposait sur
// `NODE_ENV !== 'production'` — un déploiement Render/Docker sans NODE_ENV se
// retrouvait sans authentification. Le contournement exige désormais un choix
// EXPLICITE `AUTH_DEV_BYPASS=1` (posé par start.bat), plus le marqueur
// d'environnement accidentel.
function devBypassAllowed() {
  return process.env.AUTH_DEV_BYPASS === '1'
}

function isLocalSocket(req) {
  const ip = req.socket?.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

const localOrAuth = (req, res, next) => {
  if (isLocalSocket(req) || devBypassAllowed()) return next()
  return securityEngine.authenticate(req, res, next)
}

module.exports = { localOrAuth, isLocalSocket, devBypassAllowed }
