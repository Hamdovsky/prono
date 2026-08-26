const fs = require('fs')
const path = require('path')
const logger = require('./logger')

const SCRAPER_PROGRESS_FILE = path.join(__dirname, '..', 'data', 'scraper_progress.json')
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json')

/**
 * Reads the current scraper progress from the data file.
 * Returns a promise that resolves to the progress object.
 */
async function readScraperProgress() {
  try {
    if (fs.existsSync(SCRAPER_PROGRESS_FILE)) {
      const data = await fs.promises.readFile(SCRAPER_PROGRESS_FILE, 'utf8')
      return JSON.parse(data)
    }
  } catch (err) {
    logger.error(`Error reading scraper progress: ${err.message}`)
  }
  return { isRunning: false, total: 0, done: 0, percent: 0, remaining: 0, lastUpdated: null }
}

async function saveScraperProgress(progress) {
  try {
    await fs.promises.writeFile(
      SCRAPER_PROGRESS_FILE,
      JSON.stringify({ ...progress, lastUpdated: new Date().toISOString() }, null, 2)
    )
  } catch (err) {
    logger.error(`Error saving scraper progress: ${err.message}`)
  }
}

/**
 * [C11 — reprise après arrêt] Réinitialise le flag `isRunning` d'un batch
 * interrompu (kill / crash / coupure). Le Workflow re-scanne de toute façon
 * la DB au prochain passage et fast-forward les matchs déjà analysés
 * (`[RESUME] Fast-forwarded ...`), donc aucune donnée n'est perdue : ce flag
 * stale ne sert qu'à éviter que l'UI/monitoring croie un run encore actif.
 * Appelé UNE fois au boot (server.js). Idempotent, jamais destructif.
 */
async function resetStaleScraperProgress({ maxAgeMs = 30 * 60 * 1000 } = {}) {
  try {
    const p = await readScraperProgress()
    if (!p || !p.isRunning) return
    const age = p.lastUpdated ? Date.now() - new Date(p.lastUpdated).getTime() : Infinity
    if (age > maxAgeMs) {
      await saveScraperProgress({
        ...p,
        isRunning: false,
        interrupted: true,
        note: 'Batch interrompu par arret serveur - reprise automatique au prochain scan (fast-forward DB)',
      })
      logger.info(
        `[SCRAPER-RESUME] Batch interrompu detecte (${p.done}/${p.total} fait, age ${Math.round(age / 60000)} min) -> flag reset. Les donnees sont en DB, le prochain scan reprendra ou il s'etait arrete.`
      )
    }
  } catch (err) {
    logger.warn(`[SCRAPER-RESUME] reset flag: ${err.message}`)
  }
}

/**
 * Saves the current tactical configuration to the data file.
 * Returns a promise.
 */
async function saveConfig(config) {
  try {
    await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
    logger.info('💾 CONFIGURATION SAVED TO DISK')
  } catch (err) {
    logger.error(`Error saving config: ${err.message}`)
  }
}

module.exports = {
  readScraperProgress,
  saveScraperProgress,
  resetStaleScraperProgress,
  saveConfig,
  SCRAPER_PROGRESS_FILE,
  CONFIG_FILE,
}
