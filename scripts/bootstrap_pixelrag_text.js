#!/usr/bin/env node
/*
 * Bootstrap rapide de l'index PixelRAG-lite (100% Sofascore) SANS Puppeteer.
 *
 * Pour chaque match programmé (peu importe la date) :
 *   1. résout l'équipe via SofascoreBypass.searchTeam
 *   2. envoie un texte d'identification à /ingest_text sur le serveur vision
 *      (CLIP si dispo, sinon hash stable — mais on a CLIP:vit-base-patch32 actif)
 *   3. l'article_id a la forme <matchId>_home|<matchId>_away
 *
 * Effet : passer l'index de 4 vecteurs à N (N=2*limit) en quelques secondes.
 * Rapide, sans navigateur, sans wiki externe.
 *
 * Usage : node scripts/bootstrap_pixelrag_text.js [--limit N]
 */

const path = require('path')
process.env.PUPPETEER_SKIP_DOWNLOAD = '1'

const STITCH_ROOT = path.join(__dirname, '..')
const VISION_URL = (process.env.PIXELRAG_URL || 'http://127.0.0.1:30002').replace(/\/$/, '')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : 50
})()

const logger = require(path.join(STITCH_ROOT, 'core', 'logger'))
const db = require(path.join(STITCH_ROOT, 'core', 'database'))
const bypass = require(path.join(STITCH_ROOT, 'services', 'scrapers', 'SofascoreBypass'))

function parseArgs() {
  return { limit: LIMIT }
}

async function visionUp() {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3000)
    try {
      const r = await fetch(`${VISION_URL}/health`, { signal: ctl.signal })
      if (!r.ok) return false
      const h = await r.json()
      return h.status === 'ok'
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return false
  }
}

async function ingestText(text, articleId, title) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 10000)
    try {
      const r = await fetch(`${VISION_URL}/ingest_text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, article_id: articleId, title: title || text.slice(0, 80) }),
        signal: ctl.signal,
      })
      if (!r.ok) {
        logger.warn(`[BOOT] /ingest_text HTTP ${r.status} for ${articleId}`)
        return null
      }
      return await r.json()
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    logger.warn(`[BOOT] /ingest_text failed for ${articleId}: ${e.message}`)
    return null
  }
}

async function resolveTeam(name) {
  if (!name) return null
  try {
    return await bypass.searchTeam(name)
  } catch (e) {
    return null
  }
}

async function main() {
  const { limit } = parseArgs()
  const up = await visionUp()
  if (!up) {
    logger.error(`[BOOT] Serveur vision local indisponible sur ${VISION_URL} — abandon`)
    process.exit(1)
  }
  const status = await fetch(`${VISION_URL}/status`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  logger.info(
    `[BOOT] Démarrage : serveur=${VISION_URL} model=${status && status.model} ` +
      `index_size_before=${status && status.total_vectors} limit=${limit}`
  )

  const matches = await db
    .getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS', 'finished', 'FT', 'AET', 'PEN'], { limit: 500 })
    .catch(() => [])

  // Filtre : éviter les doublons (mêmes équipes re-jouées) — on garde le plus récent
  // par paire (home, away) pour maximiser la diversité dans l'index.
  const seenPairs = new Set()
  const candidates = []
  for (const m of matches) {
    if (!m.homeTeam || !m.awayTeam) continue
    const key = `${m.homeTeam}__${m.awayTeam}`
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    candidates.push(m)
    if (candidates.length >= limit) break
  }
  logger.info(`[BOOT] ${candidates.length} match(s) unique-pair à indexer`)

  let ok = 0
  let failed = 0
  const t0 = Date.now()
  for (const m of candidates) {
    const matchId = m.id || `${m.homeTeam}_${m.awayTeam}`
    const [homeT, awayT] = await Promise.all([resolveTeam(m.homeTeam), resolveTeam(m.awayTeam)])
    if (!homeT && !awayT) {
      failed++
      continue
    }
    const tasks = []
    if (homeT) {
      const text = `${homeT.name} football club team roster ${m.league || ''}`.trim()
      tasks.push(
        ingestText(text, `${matchId}_home`, homeT.name).then((r) => {
          if (r && r.success) ok++
          else failed++
        })
      )
    }
    if (awayT) {
      const text = `${awayT.name} football club team roster ${m.league || ''}`.trim()
      tasks.push(
        ingestText(text, `${matchId}_away`, awayT.name).then((r) => {
          if (r && r.success) ok++
          else failed++
        })
      )
    }
    await Promise.all(tasks)
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const finalStatus = await fetch(`${VISION_URL}/status`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  logger.info(
    `[BOOT] Terminé en ${dt}s : ${ok} ingest(s) OK, ${failed} échec(s). ` +
      `index_size_after=${finalStatus && finalStatus.total_vectors} ` +
      `model=${finalStatus && finalStatus.model}`
  )
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      logger.error(`[BOOT] fatal: ${e.message}`)
      process.exit(2)
    }
  )
}

module.exports = { main }
