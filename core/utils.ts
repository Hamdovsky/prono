// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from './logger'

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

export = {
  readScraperProgress,
  saveScraperProgress,
  saveConfig,
  SCRAPER_PROGRESS_FILE,
  CONFIG_FILE,
}
