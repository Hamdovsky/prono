const logger = require('../core/logger')
const pixelrag = require('./pixelragService')

// Orchestrateur du contexte visuel :
//  - cache DB (table visual_context_cache, TTL 12h par défaut)
//  - recherche PixelRAG DUALE via services/pixelragService.js :
//      local (corpus Sofascore, serveur lite) + wiki (vrai PixelRAG hébergé)
//  - construction du visual_context injecté dans /predict (via mlPredictionService)
// Best-effort à 100% : retourne null si les deux backends sont absents/erreur.

const VISUAL_TTL_MS = parseInt(process.env.VISUAL_TTL_MS || (12 * 60 * 60 * 1000), 10)

function queryForMatch(match) {
  const home = match.homeTeam || match.home || ''
  const away = match.awayTeam || match.away || ''
  const league = match.league || match.tournament_name || ''
  return `Préparation du match ${home} contre ${away} (${league}) : forme des équipes, composition type, blessures, derniers résultats`
}

async function getVisualContext(match, opts = {}) {
  if (!match) return null
  const { force = false } = opts
  const matchId = match.id || match.event_id || `${match.homeTeam}_${match.awayTeam}`

  // 1. Cache DB (fresh dans la TTL)
  if (!force) {
    try {
      const db = require('../core/database')
      if (typeof db.getVisualContext === 'function') {
        const row = await db.getVisualContext(matchId)
        if (row && row.enriched_at && Date.now() - row.enriched_at < VISUAL_TTL_MS) {
          try {
            return {
              visual_confidence: row.visual_confidence ?? 1.0,
              tiles: JSON.parse(row.tiles || '[]'),
              scores: JSON.parse(row.scores || '[]'),
              screenshot_paths: JSON.parse(row.screenshot_paths || '[]'),
              article_ids: JSON.parse(row.article_ids || '[]'),
              query_text: row.query_text || '',
              visual_briefing: row.briefing || '',
              enriched_at: row.enriched_at,
              cached: true,
            }
          } catch (e) {
            logger.warn(`[VISUAL] Cache parse error ${matchId}: ${e.message}`)
          }
        }
      }
    } catch (e) {
      logger.debug(`[VISUAL] cache read failed: ${e.message}`)
    }
  }

  // 2. Recherche PixelRAG — DEUX backends (protocole identique, normalisé) :
  //    a) local : notre corpus Sofascore (capturaux live, serveur lite CLIP :30002)
  //    b) wiki  : VRAI PixelRAG hébergé (api.pixelrag.ai — Wikipédia, contexte
  //               historique/effectif/saisons). Gratuit, sans clé.
  const query = queryForMatch(match)
  const home = match.homeTeam || match.home || ''
  const away = match.awayTeam || match.away || ''
  const wikiQueries = pixelrag.wikiQueriesForMatch(home, away)
  const [localRes, wikiRes] = await Promise.all([
    pixelrag.search(query, { n_docs: 6 }),
    wikiQueries.length ? pixelrag.wiki.search(wikiQueries, { n_docs: 3 }) : null,
  ])

  const localTiles = ((localRes && localRes.tiles) || []).map((t) => ({ ...t, source: 'sofascore' }))
  const rawWikiTiles = ((wikiRes && wikiRes.tiles) || []).map((t) => ({ ...t, source: 'wikipedia' }))
  const wikiTiles = pixelrag.filterTilesByTeams(rawWikiTiles, [home, away])
  const tiles = [...localTiles, ...wikiTiles]
  if (!tiles.length && !force) {
    logger.debug(`[VISUAL] pas de contexte visuel pour ${matchId} (serveurs vision down ou index vides)`)
    return null
  }

  // Confiance continue = meilleur score cosinus TOUTES SOURCES (borné [0,1]) ; 0 si rien.
  const scores = tiles.map((t) => t.score)
  const topScore = scores.length ? Math.max(0, ...scores) : 0
  // Les chemins locaux (screenshots) ne viennent que du corpus Sofascore ;
  // les tuiles wiki sont des références (article_id/tile) résolues via /tile.
  const screenshotPaths = tiles.filter((t) => t.source === 'sofascore').map((t) => t.path).filter(Boolean)

  // 3. Persist cache
  const context = {
    visual_confidence: tiles.length ? Number(topScore.toFixed(4)) : 0.0,
    tiles,
    scores,
    screenshot_paths: screenshotPaths,
    article_ids: tiles.map((t) => t.article_id).filter((a) => a != null),
    query_text: query,
    enriched_at: Date.now(),
  }
  try {
    const db = require('../core/database')
    if (typeof db.setVisualContext === 'function') {
      await db.setVisualContext({
        match_id: matchId,
        screenshot_paths: context.screenshot_paths,
        article_ids: context.article_ids,
        visual_confidence: context.visual_confidence,
        tiles: context.tiles,
        scores: context.scores,
        query_text: context.query_text,
        enriched_at: context.enriched_at,
      })
    }
  } catch (e) {
    logger.debug(`[VISUAL] cache write failed: ${e.message}`)
  }

  // 4. Briefing visuel (lecteur RAG Groq vision) — best-effort, budget mensuel,
  // persisté dans le cache pour ne jamais rappeler Groq à chaque prédiction.
  try {
    const briefingService = require('./visualBriefingService')
    if (briefingService.enabled()) {
      const briefing = await briefingService.generateBriefing(match, context)
      if (briefing) {
        context.visual_briefing = briefing
        const db = require('../core/database')
        if (typeof db.setVisualContext === 'function') {
          await db.setVisualContext({
            match_id: matchId,
            screenshot_paths: context.screenshot_paths,
            article_ids: context.article_ids,
            visual_confidence: context.visual_confidence,
            tiles: context.tiles,
            scores: context.scores,
            query_text: context.query_text,
            enriched_at: context.enriched_at,
            briefing,
          })
        }
      }
    }
  } catch (be) {
    logger.debug(`[VISUAL] briefing indisponible: ${be.message}`)
  }

  return context
}

// Retourne la liste des screenshots déjà capturés pour un match (utilisé par
// le batch pour éviter les doubles captures).
async function getScreenshotPaths(matchId) {
  try {
    const db = require('../core/database')
    if (typeof db.getVisualContext === 'function') {
      const row = await db.getVisualContext(matchId)
      if (row) return JSON.parse(row.screenshot_paths || '[]')
    }
  } catch (e) {
    logger.debug(`[VISUAL] getScreenshotPaths failed: ${e.message}`)
  }
  return []
}

async function getVisionHealth() {
  return pixelrag.getHealth()
}

module.exports = { getVisualContext, getScreenshotPaths, getVisionHealth, queryForMatch }