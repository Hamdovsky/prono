#!/usr/bin/env node
/*
 * Cron de ré-ingestion PixelRAG-lite : tourne périodiquement (recommandé : 6h)
 * pour les matchs upcoming non encore enrichis.
 *
 * Stratégie : bootstrap_pixelrag_text.js alimente l'index via /ingest_text
 * (rapide, sans Puppeteer). ScrapeVisualBatch.js reste pour les captures riches
 * (Puppeteer) si on veut de la qualité maximale.
 *
 * Usage :
 *   node scripts/cron_pixelrag_refresh.js [--limit N] [--visual] [--force]
 *
 *   --limit N : nombre max de matchs à traiter (défaut 50)
 *   --visual  : bascule sur le batch Puppeteer (lent, captures réelles)
 *   --force   : re-ingérer même si déjà couvert
 */

const path = require('path')
const STITCH_ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 50
})()
const VISUAL = args.includes('--visual')
const FORCE = args.includes('--force')

async function main() {
  const logger = require(path.join(STITCH_ROOT, 'core', 'logger'))
  if (VISUAL) {
    logger.info(`[CRON-VISUAL] mode captures Puppeteer (limit=${LIMIT}, force=${FORCE})`)
    const { main: runBatch } = require('./scrapeVisualBatch.js')
    return runBatch()
  }
  // Mode défaut : text-only, rapide
  process.env.VISUAL_BATCH_LIMIT = String(LIMIT)
  const { main: runBootstrap } = require('./bootstrap_pixelrag_text.js')
  logger.info(`[CRON-VISUAL] mode bootstrap text (limit=${LIMIT}, force=${FORCE})`)
  return runBootstrap()
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      // eslint-disable-next-line no-console
      console.error(`[CRON-VISUAL] fatal: ${e.message}`)
      process.exit(2)
    }
  )
}

module.exports = { main }
