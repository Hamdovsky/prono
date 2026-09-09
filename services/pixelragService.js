const logger = require('../core/logger')

// Client HTTP du service vision. Parle le VRAI protocole PixelRAG
// (https://github.com/StarTrail-org/PixelRAG, serve/src/pixelrag_serve/api.py) :
//   POST /search  { queries:[{text|image|embedding}], n_docs } -> { results:[{ hits:[...] }] }
//   GET  /tile/{article_id}/{tile_index}/{chunk_index} -> PNG (hébergé uniquement)
//   GET  /status  -> { total_vectors, dimension, model, ... }
//   GET  /health  -> { status:"ok" }
//
// DEUX backends (même protocole, même normalisation) :
//   - local : PIXELRAG_URL (défaut :30002) = serveur "lite" CLIP sur NOTRE corpus
//             Sofascore (core/visual_server.py). Extensions locales : /ingest, /embed.
//   - wiki  : PIXELRAG_WIKI_URL (défaut https://api.pixelrag.ai) = VRAI PixelRAG
//             hébergé (Qwen3-VL-2B+LoRA, ~26M vecteurs Wikipédia, gratuit, sans clé).
//
// Dégradation douce : null / success:false si down, ne casse jamais la prédiction.

const LOCAL_URL = (process.env.PIXELRAG_URL || 'http://127.0.0.1:30002').replace(/\/$/, '')
// Wiki désactivé par défaut (plan 2026-09-08 : PixelRAG = local + Sofascore uniquement).
// Pour réactiver le wiki (index hébergé Wikipédia), définir PIXELRAG_WIKI_URL=https://api.pixelrag.ai.
const WIKI_URL_RAW = process.env.PIXELRAG_WIKI_URL
const WIKI_ENABLED = Boolean(WIKI_URL_RAW && WIKI_URL_RAW.trim() && WIKI_URL_RAW.trim().toLowerCase() !== 'disabled')
const WIKI_URL = WIKI_ENABLED ? WIKI_URL_RAW.replace(/\/$/, '') : ''
const HEALTH_TIMEOUT = 3000
const SEARCH_TIMEOUT = 15000
const TILE_TIMEOUT = 10000

/**
 * Normalise la réponse PixelRAG `{results:[{hits:[...]}]}` (et le format lite
 * `{tiles:[...], scores:[...]}`) en `{ tiles, scores }` homogène pour stitch.
 */
function normalizeSearchResponse(raw) {
  if (!raw) return null
  let hits = []
  if (Array.isArray(raw.results)) {
    for (const r of raw.results) if (r && Array.isArray(r.hits)) hits = hits.concat(r.hits)
  } else if (Array.isArray(raw.tiles)) {
    hits = raw.tiles
  }
  const tiles = hits.map((h, i) => {
    const rawUrl = h.url || ''
    const isHttp = /^https?:\/\//i.test(rawUrl)
    return {
      article_id: h.article_id != null ? String(h.article_id) : h.article_id,
      tile_index: h.tile_index != null ? h.tile_index : i,
      chunk_index: h.chunk_index,
      score: typeof h.score === 'number' ? h.score : 0,
      url: rawUrl,
      // Le vrai PixelRAG renvoie un TITRE Wikipédia ("2011–12 Cruz Azul season"),
      // pas une URL -> on la construit pour le lecteur/la UI.
      wiki_url: !isHttp && rawUrl ? `https://en.wikipedia.org/wiki/${encodeURIComponent(rawUrl.replace(/ /g, '_'))}` : isHttp ? rawUrl : '',
      path: h.path || '',
      title: rawUrl || h.title || String(h.article_id ?? ''),
    }
  })
  const scores = tiles.map((t) => t.score)
  return { success: true, tiles, scores, raw }
}

function _makeClient(baseUrl) {
  async function _post(path, body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        logger.warn(`⚠️ [VISUAL] ${baseUrl}${path} HTTP ${res.status}`)
        return null
      }
      return await res.json()
    } catch (e) {
      logger.debug(`[VISUAL] ${path} indisponible: ${e.message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function _get(path, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal })
      if (!res.ok) return null
      return await res.json()
    } catch (e) {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function _getBinary(path, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > 0 ? buf : null
    } catch (e) {
      logger.debug(`[VISUAL] ${path} indisponible: ${e.message}`)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Recherche textuelle (et/ou image) → tuiles classées par similarité cosinus.
   * @param {string|{text:string}[]} query
   */
  async function search(query, opts = {}) {
    const queries = Array.isArray(query)
      ? query.filter(Boolean).map((q) => (typeof q === 'string' ? { text: q } : q))
      : [{ text: String(query) }]
    if (!queries.length) return null
    const body = { queries, n_docs: opts.n_docs || 10 }
    if (opts.instruction) body.instruction = opts.instruction
    if (opts.articles_only) body.articles_only = true
    if (opts.department) body.department = opts.department
    const raw = await _post('/search', body, opts.timeout || SEARCH_TIMEOUT)
    return normalizeSearchResponse(raw)
  }

  /** Recherche par image (base64) — support natif PixelRAG. */
  async function searchByImage(imageBase64, opts = {}) {
    const raw = await _post(
      '/search',
      { queries: [{ image: imageBase64 }], n_docs: opts.n_docs || 10 },
      opts.timeout || SEARCH_TIMEOUT
    )
    return normalizeSearchResponse(raw)
  }

  async function getStatus() {
    const s = await _get('/status', HEALTH_TIMEOUT)
    if (s) return s
    const h = await _get('/health', HEALTH_TIMEOUT)
    return h ? { status: h.status, lite: true } : null
  }

  async function getHealth() {
    const h = await _get('/health', HEALTH_TIMEOUT)
    return h && h.status ? h : null
  }

  /** Récupère la capture PNG d'une tuile (endpoint du vrai PixelRAG hébergé). */
  async function getTile(articleId, tileIndex, chunkIndex) {
    if (articleId == null || tileIndex == null) return null
    return _getBinary(`/tile/${articleId}/${tileIndex}/${chunkIndex || 0}`, TILE_TIMEOUT)
  }

  /**
   * Agrège lineups + injuries + statistics + H2H d'un event Sofascore en 1 round-trip
   * (remplace 3-4 appels séparés du scraper historique). Embedding CLIP stocké
   * pour recherche sémantique.
   * @param {string|number} eventId — id Sofascore (entier)
   * @param {{force?: boolean, timeoutMs?: number}} [opts]
   */
  async function enrichMatch(eventId, opts = {}) {
    if (eventId == null) return null
    const path = `/enrich/${encodeURIComponent(String(eventId))}`
    const timeoutMs = opts.timeoutMs || 20000
    if (opts.force) {
      return _post(path, { force: true }, timeoutMs)
    }
    return _get(path, timeoutMs)
  }

  // ── Endpoints spécifiques au serveur "lite" local (inexistants dans le vrai
  // PixelRAG, qui indexe hors-ligne). Utilisés uniquement par scrapeVisualBatch. ──
  async function ingest(imagePath, articleId, timeout = 20000) {
    return _post('/ingest', { image_path: imagePath, article_id: articleId }, timeout)
  }

  async function embed(imagePath, timeout = 20000) {
    return _post('/embed', { image_path: imagePath }, timeout)
  }

  return { baseUrl, search, searchByImage, getStatus, getHealth, getTile, ingest, embed, enrichMatch }
}

const local = _makeClient(LOCAL_URL)
// Wiki client optionnel (désactivé par défaut depuis 2026-09-08). `null` quand désactivé
// pour court-circuiter toutes les requêtes externes vers api.pixelrag.ai.
const wiki = WIKI_ENABLED ? _makeClient(WIKI_URL) : null

// ── Hygiène de requête Wikipédia (index hébergé générique) ──
// "X football club season squad" ramenait des tuiles hors-sujet (joueurs d'autres
// clubs). On cible la SAISON COURANTE et on ne garde que les tuiles dont le titre
// Wikipédia mentionne une des équipes — si rien ne passe, on garde tout (le
// lecteur vision signale l'off-topic, mieux vaut que de ne rien récupérer).
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function currentSeasonLabel() {
  const y = new Date().getFullYear()
  const m = new Date().getMonth() + 1
  const start = m >= 7 ? y : y - 1 // saisons européennes ~juillet→juin
  return `${start}-${String(start + 1).slice(2)}` // ex "2026-27"
}

function wikiQueriesForMatch(home, away) {
  const season = currentSeasonLabel()
  const qs = []
  if (home) qs.push(`${home} ${season} season football`)
  if (away) qs.push(`${away} ${season} season football`)
  if (home && away) qs.push(`${home} vs ${away} football head-to-head history`)
  return qs
}

function filterTilesByTeams(tiles, teamNames) {
  const keys = teamNames.map(normName).filter((k) => k.length >= 4)
  if (!keys.length) return tiles
  const kept = tiles.filter((t) => {
    const title = normName(t.url || t.title || '')
    return keys.some((k) => title.includes(k))
  })
  return kept.length ? kept : tiles
}

module.exports = {
  VISION_URL: LOCAL_URL,
  WIKI_URL,
  local,
  wiki,
  normalizeSearchResponse,
  wikiQueriesForMatch,
  filterTilesByTeams,
  currentSeasonLabel,
  // ── Rétro-compatibilité : exports de premier niveau = client LOCAL ──
  search: local.search,
  searchByImage: local.searchByImage,
  getStatus: local.getStatus,
  getHealth: local.getHealth,
  ingest: local.ingest,
  embed: local.embed,
  enrichMatch: local.enrichMatch,
  // /tile n'existe que sur le vrai PixelRAG hébergé. Wiki désactivé par défaut :
  // retourne null si PIXELRAG_WIKI_URL est vide (plan 2026-09-08 : 100% Sofascore local).
  getTile: wiki ? wiki.getTile : (async () => null),
}
