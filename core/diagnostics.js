const logger = require('./logger')

async function logDiagnostic() {
  try {
    const db = require('./database').db
    const pg = require('./pg_connector')
    const usingPG = pg.usingPostgres && pg.usingPostgres()

    if (db) {
      const total = (db.prepare('SELECT COUNT(*) as c FROM matches').get() || {}).c || 0
      const scheduled =
        (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS')"
            )
            .get() || {}
        ).c || 0
      const finished =
        (
          db
            .prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('FT','finished','Ended')")
            .get() || {}
        ).c || 0
      const withOdds =
        (db.prepare('SELECT COUNT(*) as c FROM matches WHERE odds_home IS NOT NULL').get() || {})
          .c || 0
      const withPredictions =
        (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM matches WHERE expected_score IS NOT NULL AND expected_score != 'N/A'"
            )
            .get() || {}
        ).c || 0
      const withXG =
        (db.prepare('SELECT COUNT(*) as c FROM matches WHERE home_xg IS NOT NULL').get() || {}).c ||
        0
      const today =
        (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now')"
            )
            .get() || {}
        ).c || 0
      const tomorrow =
        (
          db
            .prepare(
              "SELECT COUNT(*) as c FROM matches WHERE DATE(timestamp / 1000, 'unixepoch') = DATE('now', '+1 day')"
            )
            .get() || {}
        ).c || 0

      logger.info('══════════════════════════════════════════')
      logger.info(`📊 DIAGNOSTIC DES DONNÉES (SQLite${usingPG ? ' + PostgreSQL' : ''})`)
      logger.info(`   Matchs total:     ${total}`)
      logger.info(`   À venir:          ${scheduled}`)
      logger.info(`   Terminés:         ${finished}`)
      logger.info(`   Avec cotes:       ${withOdds}`)
      logger.info(`   Avec prédictions: ${withPredictions}`)
      logger.info(`   Avec xG:          ${withXG}`)
      logger.info(`   Aujourd'hui:      ${today}`)
      logger.info(`   Demain:           ${tomorrow}`)
      if (total === 0 && usingPG) logger.info('   ℹ️  SQLite vide — données dans PostgreSQL')
      if (scheduled < 10 && total < 10) logger.warn('   ⚠️  MOINS DE 10 MATCHS DISPONIBLES')
      if (withPredictions < 5 && total < 10) logger.warn('   ⚠️  MOINS DE 5 PRÉDICTIONS')
      if (withOdds === 0) logger.warn('   ⚠️  AUCUNE COTE')
    }

    if (usingPG) {
      try {
        const { query } = pg
        const pgTotal = await query('SELECT COUNT(*) as c FROM matches')
        const pgCount = parseInt(pgTotal?.rows?.[0]?.c || pgTotal?.[0]?.c || 0)
        const pgScheduled = await query(
          "SELECT COUNT(*) as c FROM matches WHERE status IN ('scheduled','notstarted','NS','not_started')"
        )
        const pgSchedCount = parseInt(pgScheduled?.rows?.[0]?.c || pgScheduled?.[0]?.c || 0)
        const pgWithPred = await query(
          "SELECT COUNT(*) as c FROM matches WHERE expected_score IS NOT NULL AND expected_score != 'N/A'"
        )
        const pgPredCount = parseInt(pgWithPred?.rows?.[0]?.c || pgWithPred?.[0]?.c || 0)

        logger.info('──────────────────────────────────────────')
        logger.info('📊 DIAGNOSTIC PostgreSQL (Neon)')
        logger.info(`   Total:     ${pgCount}`)
        logger.info(`   À venir:   ${pgSchedCount}`)
        logger.info(`   Prédictions: ${pgPredCount}`)
        logger.info('══════════════════════════════════════════')
      } catch (pgErr) {
        logger.warn(`[DIAG] PostgreSQL query failed: ${pgErr.message}`)
      }
    }
  } catch (e) {
    logger.warn(`[DIAG] Erreur: ${e.message}`)
  }
}

function scheduleDailyDiagnose(delayMs = 10000) {
  setTimeout(() => logDiagnostic(), delayMs)
}

module.exports = { logDiagnostic, scheduleDailyDiagnose }
