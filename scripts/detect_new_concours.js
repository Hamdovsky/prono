const https = require('https')
const http = require('http')
const path = require('path')
const fs = require('fs')
const logger = require('../core/logger')

const LAST_CONCOURS_PATH = path.join(__dirname, '..', 'data', 'last_promosport_concours.txt')
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'promosport.json')
const promosportResultService = require('../services/promosportResultService')

function getLastKnownConcours() {
  try {
    if (fs.existsSync(LAST_CONCOURS_PATH)) {
      return parseInt(fs.readFileSync(LAST_CONCOURS_PATH, 'utf8').trim(), 10)
    }
  } catch (_) {}
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return config.lastConcours || 877
  } catch (_) {}
  return 877
}

function saveLastConcours(no) {
  try {
    fs.writeFileSync(LAST_CONCOURS_PATH, String(no), 'utf8')
  } catch (_) {}
}

function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function extractConcoursNumber(html) {
  const patterns = [
    /CONCOURS\s*N[°\s]*(\d{3,4})/i,
    /CONCOURS\s*(\d{3,4})/i,
    /concours[-\s]*(\d{3,4})/i,
    /num[ée]ro\s*(?:du\s*)?concours[:\s]*(\d{3,4})/i
  ]
  for (const p of patterns) {
    const m = html.match(p)
    if (m) return parseInt(m[1], 10)
  }
  const linkMatch = html.match(/grille[=\/](\d{3,4})/gi)
  if (linkMatch) {
    const nums = linkMatch.map(s => parseInt(s.match(/\d+/)[0], 10)).filter(n => n > 800)
    if (nums.length > 0) return Math.max(...nums)
  }
  return null
}

async function generateGridsForConcours(concoursNumber) {
  try {
    logger.info(`[DETECT] Auto-generating grids for concours ${concoursNumber}...`)
    // Fetch the scraped matches for this concours via promosport_scraper
    const { scrapePromosport } = require('../core/promosport_scraper')
    const matches = await scrapePromosport()
    if (!matches || matches.length === 0) {
      logger.warn('[DETECT] No scraped matches available for grid generation')
      return false
    }

    // Generate grids using the engine
    const { generatePromosportGrids } = require('../core/promosport_engine')
    const grids = await generatePromosportGrids(matches)
    if (!grids || grids.length === 0) {
      logger.warn('[DETECT] Grid generation failed')
      return false
    }

    // Store predictions for accuracy tracking
    const dateStr = new Date().toISOString().slice(0, 10)
    promosportResultService.storePrediction(String(concoursNumber), dateStr, grids)

    // Warm up Redis cache
    try {
      const redisCache = require('../services/redisCache')
      const cacheKey = `promosport:${concoursNumber}`
      await redisCache.set(cacheKey, { concours: concoursNumber, date: dateStr, grids: grids.map(g => g.name), generatedAt: Date.now() }, 86400)
      logger.info('[DETECT] Redis cache warmed up for concours', concoursNumber)
    } catch (_) {}

    logger.info(`[DETECT] Grids generated and stored for concours ${concoursNumber}`)
    return true
  } catch (e) {
    logger.error(`[DETECT] Grid generation error: ${e.message}`)
    return false
  }
}

async function sendTelegramNotification(concoursNumber, generated) {
  try {
    const botService = require('../services/botService')
    let msg = `🎯 <b>Nouveau Concours Promosport Détecté</b>\nConcours: ${concoursNumber}\n`
    if (generated) {
      msg += `✅ 4 grilles générées et stockées automatiquement\n`
      msg += `📊 Accuracy dashboard prêt`
    } else {
      msg += `⚠️ Grilles non générées (scraping indisponible)`
    }
    botService.sendAlert(msg)
  } catch (_) {}
}

async function detectNewConcours() {
  const lastKnown = getLastKnownConcours()
  logger.info(`[DETECT] Last known concours: ${lastKnown}`)

  const sources = [
    `https://www.promosport-pronostic.com/index.php/welcome/promo_result?grille=${lastKnown + 1}&jeux=Promosport`,
    `https://www.promosport-pronostic.com/index.php/welcome/promo_result?grille=${lastKnown}&jeux=Promosport`,
    'https://www.promosport-pronostic.com/',
    'https://www.promosportplus.com/promosport-concours-de-la-semaine'
  ]

  for (const url of sources) {
    try {
      const html = await fetchUrl(url)
      const detected = extractConcoursNumber(html)
      if (detected && detected > lastKnown) {
        logger.info(`[DETECT] New concours found: ${detected} (was ${lastKnown})`)
        saveLastConcours(detected)
        // Auto-generate grids + cache warm-up
        const gridsGenerated = await generateGridsForConcours(detected)
        await sendTelegramNotification(detected, gridsGenerated)
        return { found: true, concoursNumber: detected, previous: lastKnown, gridsGenerated }
      }
      if (detected && detected === lastKnown) {
        logger.info(`[DETECT] Latest concours still ${detected}, no change`)
        return { found: false, concoursNumber: detected }
      }
    } catch (e) {
      logger.debug(`[DETECT] Failed to fetch ${url}: ${e.message}`)
    }
  }

  logger.info('[DETECT] Could not determine latest concours from any source')
  return { found: false, concoursNumber: lastKnown }
}

module.exports = { detectNewConcours, getLastKnownConcours, saveLastConcours }
