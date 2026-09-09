/**
 * noop_service.js — bouchon de service pour `concurrently`.
 *
 * Loggue un message d'archivage et reste vivant sans consommer de ressources
 * (pas de kill-others cascade : --kill-others tue toute la pile si un service
 * sort, donc un service « retiré » doit rester présent mais inerte).
 *
 * Usage dans start.bat : remplace un service archivé tout en gardant le compte
 * --names/--prefix-colors aligné. Message expliqué par le token passé en argv.
 */
const MESSAGES = {
  scraper:
    '[SCRAPER] Workflow Puppeteer standalone ARCHIVÉ — redondant avec le scan ' +
    'résilient du cron (fixtures livescore + règlement + PixelRAG /enrich) et ' +
    'il monopolise scraper:lock au détriment du cron. Réactiver : ' +
    'SCRAPER_STANDALONE=1 avant start.bat, ou « npm run scraper » à la main.',
}

const token = process.argv[2]
console.log(MESSAGES[token] || `[noop] service '${token || '?'}' archivé.`)
setInterval(() => {}, 60 * 60 * 1000)
