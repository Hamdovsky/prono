/*
 * Batch de capture visuelle (PixelRAG-lite) — Screenshots locaux via Puppeteer.
 *
 * Usage : node scripts/scrapeVisualBatch.js [--limit N] [--force] [--dry-run]
 *
 * Pour chaque match programmé (scheduled/NOT_STARTED/NS, futur, sans contexte
 * visuel frais) :
 *   1. résout les IDs équipes via le bypass Sofascore (curl_cffi, anti-bot contourné)
 *   2. capture la page équipe domicile + extérieur (SofaScore) [si serveur vision local up]
 *   3. sauvegarde en local data/visual/<matchId>/home.jpg & away.jpg
 *   4. ingère les deux captures dans le serveur vision (port 30002)
 *   5. PRÉ-REMPLISSAGE WIKI : recherche le vrai PixelRAG hébergé (api.pixelrag.ai)
 *      sur les saisons/effectifs des deux équipes + télécharge les top tuiles PNG
 *   6. mémorise le contexte fusionné dans visual_context_cache
 *
 * Si le serveur vision local est down -> mode wiki-only (pas de navigateur).
 *
 * Rate-limit par défaut : 3 s entre deux matchs (VISUAL_RATE_MS).
 * Strictement local : pas de cloud, tout est stocké sur la machine.
 * Ne casse jamais : une erreur par match est journalisée puis ignorée.
 */

process.env.PUPPETEER_SKIP_DOWNLOAD = '1'

const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

const STITCH_ROOT = path.join(__dirname, '..')
const VISUAL_DIR = path.join(STITCH_ROOT, 'data', 'visual')
const DISABLED = process.env.DISABLE_SOFASCORE === 'true'
const VISION_URL = process.env.PIXELRAG_URL || 'http://127.0.0.1:30002'
const SEARCH_API = 'https://www.sofascore.com/api/v1/search/all'
const TEAM_PAGE = (id) => `https://www.sofascore.com/team/football/team/${id}`

function parseCliArgs() {
  const args = process.argv.slice(2)
  let limit = parseInt(process.env.VISUAL_BATCH_LIMIT || '100', 10)
  let force = false
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1], 10) || limit
    else if (args[i] === '--force') force = true
    else if (args[i] === '--dry-run') dryRun = true
  }
  return { limit, force, dryRun }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarity(a, b) {
  const aa = norm(a).split(' ')
  const bb = norm(b).split(' ')
  if (!aa.length || !bb.length) return 0
  const setB = new Set(bb)
  const hits = aa.filter((w) => setB.has(w)).length
  return hits / Math.max(aa.length, bb.length)
}

async function visionUp() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch(`${VISION_URL}/health`, { signal: controller.signal })
      if (!res.ok) return false
      const h = await res.json()
      return h.status === 'ok'
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return false
  }
}

async function resolveTeamId(page, query, expectedName) {
  // Voie principale : bypass curl_cffi (api.sofascore.com) — non bloqué par l'anti-bot.
  try {
    const bypass = require('../services/scrapers/SofascoreBypass')
    const t = await bypass.searchTeam(expectedName)
    if (t && t.id) return { id: t.id, name: t.name, score: 1.0 }
  } catch (e) {
    logger.warn(`[VISUAL] bypass searchTeam indisponible: ${e.message}`)
  }
  // Fallback : navigation Puppeteer (souvent ERR_ABORTED sur l'API JSON).
  if (!page) return null
  const url = `${SEARCH_API}?q=${encodeURIComponent(String(query).trim())}&page=0`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await sleep(1200)
  let json = null
  try {
    const text = await page.evaluate(() => document.body.innerText)
    const start = text.indexOf('{')
    if (start >= 0) json = JSON.parse(text.slice(start))
  } catch (e) {
    json = null
  }
  if (!json || !Array.isArray(json.teams)) return null
  let best = null
  let bestScore = 0.25
  for (const t of json.teams) {
    const s = similarity(expectedName, t.name)
    if (s > bestScore) {
      bestScore = s
      best = t
    }
  }
  return best ? { id: best.id, name: best.name, score: bestScore } : null
}

async function screenshotTeam(browser, teamId, outPath) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1280, height: 1600, deviceScaleFactor: 1 })
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
    await page.goto(TEAM_PAGE(teamId), { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(4500)
    // fullPage → capture longue, chunkable en "tiles" par le pipeline PixelRAG.
    await page.screenshot({ path: outPath, fullPage: true, type: 'jpeg', quality: 80 })
    return true
  } catch (e) {
    logger.warn(`[VISUAL] screenshot echoué team ${teamId}: ${e.message}`)
    return false
  } finally {
    await page.close().catch(() => {})
  }
}

// Corpus natif PixelRAG : articles.json (article_id -> {url, title, department}).
// Un vrai `pixelrag index build` sur hôte GPU/Mac consomme ces captures + ce fichier.
const ARTICLES_JSON = path.join(VISUAL_DIR, 'articles.json')

// ── Wiki prefill : VRAI PixelRAG hébergé (api.pixelrag.ai, gratuit, sans clé) ──
// Recherche les saisons/effectifs des deux équipes, télécharge les top tuiles PNG
// en local et les fusionne dans visual_context_cache -> la prédiction lit tout depuis
// le cache, sans jamais dépendre de l'API en temps réel.
async function fetchWikiTiles(pixelrag, homeT, awayT, dir, dryRun) {
  const queries = [
    homeT && `${homeT.name} football club season squad`,
    awayT && `${awayT.name} football club season squad`,
  ].filter(Boolean)
  if (!queries.length) return []
  const res = await pixelrag.wiki.search(queries, { n_docs: 2 })
  if (!res || !res.success) return []
  const out = []
  for (const t of res.tiles) {
    const tile = { ...t, source: 'wikipedia' }
    if (!dryRun && t.article_id != null) {
      const png = await pixelrag.getTile(t.article_id, t.tile_index, t.chunk_index || 0)
      if (png) {
        try {
          const fname = `wiki_${t.article_id}_${t.tile_index}_${t.chunk_index || 0}.png`
          const fpath = path.join(dir, fname)
          fs.writeFileSync(fpath, png)
          tile.path = fpath
        } catch (e) {
          logger.warn(`[VISUAL] wiki tile write failed: ${e.message}`)
        }
      }
    }
    out.push(tile)
  }
  return out
}
function upsertArticle(articleId, url, title, department) {
  let map = {}
  try {
    if (fs.existsSync(ARTICLES_JSON)) map = JSON.parse(fs.readFileSync(ARTICLES_JSON, 'utf-8'))
  } catch (e) {
    map = {}
  }
  map[articleId] = { url, title, department: department || 'football' }
  try {
    fs.mkdirSync(VISUAL_DIR, { recursive: true })
    fs.writeFileSync(ARTICLES_JSON, JSON.stringify(map, null, 2))
  } catch (e) {
    logger.warn(`[VISUAL] articles.json write failed: ${e.message}`)
  }
}

async function main() {
  const { limit, force, dryRun } = parseCliArgs()
  if (DISABLED) {
    logger.warn('[VISUAL] DISABLE_SOFASCORE=true — batch visuel désactivé')
    return { status: 'disabled' }
  }
  const localUp = await visionUp()
  if (!localUp) {
    logger.warn(`[VISUAL] Serveur vision local indisponible sur ${VISION_URL} — mode wiki-only (pré-remplissage via le vrai PixelRAG hébergé, captures Sofascore ignorées)`)
  }

  const db = require('../core/database')
  const pixelrag = require('../services/pixelragService')
  const getMatches = () =>
    db.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']).catch(() => [])

  const matches = await getMatches()
  const now = Date.now()
  const candidates = matches
    .filter((m) => (m.startTimestamp ? m.startTimestamp * 1000 > now - 3600000 : true))
    .slice(0, limit)

  logger.info(`[VISUAL] ${candidates.length} match(s) à traiter (limit=${limit}, force=${force}, dry=${dryRun})`)

  let puppeteer
  try {
    puppeteer = require('puppeteer-extra')
    const StealthPlugin = require('puppeteer-extra-plugin-stealth')
    puppeteer.use(StealthPlugin())
  } catch (e) {
    if (localUp) {
      logger.warn(`[VISUAL] puppeteer-extra indisponible: ${e.message}. Installez: npm i -D puppeteer-extra puppeteer-extra-plugin-stealth`)
      return { status: 'no-puppeteer' }
    }
    puppeteer = null // wiki-only : pas besoin de navigateur
  }

  let browser = null
  let apiPage = null
  if (localUp && puppeteer) {
    const launchOpts = {
      headless: true,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,1000',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    }
    if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH

    browser = await puppeteer.launch(launchOpts)
    apiPage = await browser.newPage()
  }

  let ok = 0
  let skipped = 0
  let failed = 0
  const rateMs = parseInt(process.env.VISUAL_RATE_MS || '3000', 10)

  try {
    for (const m of candidates) {
      const matchId = m.id || `${m.homeTeam}_${m.awayTeam}`
      const dir = path.join(VISUAL_DIR, String(matchId).replace(/[^a-zA-Z0-9._-]/g, '_'))
      const homeOut = path.join(dir, 'home.jpg')
      const awayOut = path.join(dir, 'away.jpg')
      const seen = db.getVisualContext ? db.getVisualContext(matchId) : null
      if (seen && !force && seen.visual_confidence > 0) {
        skipped++
        continue
      }
      try {
        const [homeT, awayT] = await Promise.all([
          resolveTeamId(apiPage, m.homeTeam, m.homeTeam),
          resolveTeamId(apiPage, m.awayTeam, m.awayTeam),
        ])
        if (!homeT || !awayT) {
          throw new Error(`équipes non résolues (home=${m.homeTeam}, away=${m.awayTeam})`)
        }
        if (dryRun) {
          const wikiPreview = await fetchWikiTiles(pixelrag, homeT, awayT, dir, true)
          logger.info(`[VISUAL] dry-run ${matchId}: ${homeT.name}(${homeT.id}) vs ${awayT.name}(${awayT.id}) — ${wikiPreview.length} tuile(s) wiki dispo`)
          ok++
        } else if (!localUp) {
          // Mode wiki-only : pas de capture Sofascore, pré-remplissage via l'hébergé.
          fs.mkdirSync(dir, { recursive: true })
          const wikiTiles = await fetchWikiTiles(pixelrag, homeT, awayT, dir, false)
          if (db.setVisualContext && wikiTiles.length) {
            db.setVisualContext({
              match_id: matchId,
              screenshot_paths: wikiTiles.map((t) => t.path).filter(Boolean),
              article_ids: wikiTiles.map((t) => t.article_id),
              visual_confidence: Math.max(0, ...wikiTiles.map((t) => t.score)),
              tiles: wikiTiles,
              scores: wikiTiles.map((t) => t.score),
              query_text: `${m.homeTeam} vs ${m.awayTeam}`,
              enriched_at: Date.now(),
            })
          }
          logger.info(`[VISUAL] ${matchId}: ${wikiTiles.length} tuile(s) wiki (${homeT.name} vs ${awayT.name})`)
          ok++
        } else {
          fs.mkdirSync(dir, { recursive: true })
          const [hShot, aShot] = await Promise.all([
            screenshotTeam(browser, homeT.id, homeOut),
            screenshotTeam(browser, awayT.id, awayOut),
          ])
          const shots = []
          const articleIds = []
          if (hShot) {
            shots.push(homeOut)
            articleIds.push(`${matchId}_home`)
            upsertArticle(`${matchId}_home`, TEAM_PAGE(homeT.id), `${m.homeTeam} (domicile)`, m.league || m.tournament_name)
            await pixelrag.ingest(homeOut, `${matchId}_home`).catch(() => {})
          }
          if (aShot) {
            shots.push(awayOut)
            articleIds.push(`${matchId}_away`)
            upsertArticle(`${matchId}_away`, TEAM_PAGE(awayT.id), `${m.awayTeam} (extérieur)`, m.league || m.tournament_name)
            await pixelrag.ingest(awayOut, `${matchId}_away`).catch(() => {})
          }
          const wikiTiles = await fetchWikiTiles(pixelrag, homeT, awayT, dir, false)
          const localTiles = shots.map((s, i) => ({
            article_id: articleIds[i], tile_index: i, score: 1.0, source: 'sofascore', path: s,
          }))
          const allTiles = [...localTiles, ...wikiTiles]
          if (db.setVisualContext) {
            db.setVisualContext({
              match_id: matchId,
              screenshot_paths: [...shots, ...wikiTiles.map((t) => t.path).filter(Boolean)],
              article_ids: articleIds,
              visual_confidence: shots.length > 0 ? 1.0 : Math.max(0, ...wikiTiles.map((t) => t.score), 0),
              tiles: allTiles,
              scores: allTiles.map((t) => t.score),
              query_text: `${m.homeTeam} vs ${m.awayTeam}`,
              enriched_at: Date.now(),
            })
          }
          logger.info(`[VISUAL] ${matchId}: ${shots.length} capture(s) + ${wikiTiles.length} tuile(s) wiki (${homeT.name} vs ${awayT.name})`)
          ok++
        }
      } catch (e) {
        failed++
        logger.warn(`[VISUAL] ${matchId} échec: ${e.message}`)
      }
      await sleep(rateMs)
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }

  const summary = { status: 'ok', ok, skipped, failed, limit }
  logger.info(`[VISUAL] Terminé: ${ok} ok, ${skipped} déjà couverts, ${failed} échecs`)
  return summary
}

if (require.main === module) {
  main()
    .then((s) => {
      process.exit(s.status === 'ok' ? 0 : 1)
    })
    .catch((e) => {
      logger.error(`[VISUAL] fatal: ${e.message}`)
      process.exit(2)
    })
}

module.exports = { main }