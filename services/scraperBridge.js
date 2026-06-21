const axios = require('axios')
const logger = require('../core/logger')

let workerUrl = process.env.SCRAPER_WORKER_URL || ''
const apiKey = process.env.API_SECRET_KEY || ''

async function triggerScrape() {
  if (!workerUrl) {
    logger.warn('[SCRAPER BRIDGE] No SCRAPER_WORKER_URL set — running local scraper')
    return runLocalScraper()
  }

  try {
    const { data } = await axios.post(`${workerUrl}/scrape`, {}, {
      headers: { 'x-api-key': apiKey },
      timeout: 300000
    })
    logger.info(`[SCRAPER BRIDGE] Worker returned: ${data.success ? 'success' : 'failed'} (${data.durationMs || 0}ms)`)
    return data
  } catch (err) {
    logger.error(`[SCRAPER BRIDGE] Worker call failed: ${err.message} — falling back to local`)
    return runLocalScraper()
  }
}

async function runLocalScraper() {
  // 🛡️ Skip Puppeteer-based Workflow when DISABLE_SOFASCORE is set (Render)
  if (process.env.DISABLE_SOFASCORE === 'true') {
    logger.info('[SCRAPER BRIDGE] DISABLE_SOFASCORE=true — using HTTP scrapers only')
    try {
      const httpScraperService = require('./httpScraperService')
      const fallbackCount = await httpScraperService.processFallback()
      return { success: true, fallback: true, fallbackCount }
    } catch (fbErr) {
      try {
        const scrapeService = require('./scrapeService')
        return { success: true, source: 'scrapeService' }
      } catch (sErr) {
        return { success: false, error: 'All local scrapers failed', fallbackError: fbErr.message, scrapeError: sErr.message }
      }
    }
  }

  try {
    const Workflow = require('../SofascoreScraping/src/Workflow')
    const fs = require('fs')
    const path = require('path')

    const leaguesJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../leagues_ids.json'), 'utf8'))
    const leagues = leaguesJson.map(l => ({
      country: l.category_name.toLowerCase().replace(/\s+/g, '-'),
      league: l.tournament_name.toLowerCase().replace(/\s+/g, '-')
    }))

    const workflow = new Workflow(leagues)
    const result = await workflow.start()
    logger.info('[SCRAPER BRIDGE] Local scraper completed')
    return { success: true, result }
  } catch (err) {
    logger.error(`[SCRAPER BRIDGE] Local scraper failed: ${err.message}`)
    try {
      const httpScraperService = require('./httpScraperService')
      const fallbackCount = await httpScraperService.processFallback()
      return { success: true, fallback: true, fallbackCount }
    } catch (fbErr) {
      return { success: false, error: err.message, fallbackError: fbErr.message }
    }
  }
}

module.exports = { triggerScrape }
