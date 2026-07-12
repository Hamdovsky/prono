const logger = require('./logger')

function logDiagnostic() {
  try {
    const db = require('./database').db
    if (!db) { logger.warn('[DIAG] DB not initialised'); return }
    const total = (db.prepare('SELECT COUNT(*) as c FROM matches').get() || {}).c || 0
    const scheduled = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS')").get() || {}).c || 0
    const finished = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('FT','finished','Ended')").get() || {}).c || 0
    const withOdds = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE odds_home IS NOT NULL').get() || {}).c || 0
    const withPredictions = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE expected_score IS NOT NULL AND expected_score != 'N/A'").get() || {}).c || 0
    const withXG = (db.prepare('SELECT COUNT(*) as c FROM matches WHERE home_xg IS NOT NULL').get() || {}).c || 0
    const today = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now')").get() || {}).c || 0
    const tomorrow = (db.prepare("SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now', '+1 day')").get() || {}).c || 0

    logger.info('══════════════════════════════════════════')
    logger.info('📊 DIAGNOSTIC DES DONNÉES')
    logger.info(`   Matchs total:    ${total}`)
    logger.info(`   À venir:         ${scheduled}`)
    logger.info(`   Terminés:        ${finished}`)
    logger.info(`   Avec cotes:      ${withOdds}`)
    logger.info(`   Avec prédictions: ${withPredictions}`)
    logger.info(`   Avec xG:         ${withXG}`)
    logger.info(`   Aujourd\'hui:     ${today}`)
    logger.info(`   Demain:          ${tomorrow}`)
    if (scheduled < 10) logger.warn('   ⚠️  MOINS DE 10 MATCHS DISPONIBLES — site quasiment vide')
    if (withPredictions < 5) logger.warn('   ⚠️  MOINS DE 5 PRÉDICTIONS — l\'IA n\'a presque rien à afficher')
    if (withOdds === 0) logger.warn('   ⚠️  AUCUNE COTE — EV/chirurgical désactivé')
    logger.info('══════════════════════════════════════════')
  } catch (e) {
    logger.warn(`[DIAG] Erreur: ${e.message}`)
  }
}

function scheduleDailyDiagnose(delayMs = 10000) {
  setTimeout(logDiagnostic, delayMs)
}

module.exports = { logDiagnostic, scheduleDailyDiagnose }
