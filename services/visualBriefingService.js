const fs = require('fs')
const path = require('path')
const axios = require('axios')
const dotenv = require('dotenv')
const logger = require('../core/logger')

// Lecteur visuel du pipeline RAG PixelRAG : envoie les top tuiles PNG (Wikipédia
// hébergé ou captures Sofascore locales) à un LLM vision compatible OpenAI et
// retourne un briefing FR de 3 puces sur ce que les VISUELS apportent.
// Provider par défaut : OpenRouter (modèle GRATUIT minimax-m3:free, testé et validé
// sur nos tuiles ; fallback gemma-4-31b:free si 429). Groq reste possible via
// VISION_LLM_BASE_URL/MODEL/API_KEY.
// Garde-fou budget : data/visual_briefing_usage.json (plafond mensuel).
// Dégradation totale : null si off / sans clé / hors quota / erreur — ne casse
// jamais la prédiction.

dotenv.config()

function _usageFile() {
  return process.env.VISUAL_BRIEFING_USAGE_FILE
    ? path.resolve(process.env.VISUAL_BRIEFING_USAGE_FILE)
    : path.resolve(__dirname, '../data/visual_briefing_usage.json')
}
const MAX_MONTHLY = parseInt(process.env.VISUAL_BRIEFING_MAX_MONTHLY || '500', 10)
const VISION_BASE_URL = (process.env.VISION_LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
const VISION_MODEL = process.env.VISION_LLM_MODEL || 'minimax/minimax-m3:free'
const VISION_FALLBACK_MODEL = process.env.VISION_LLM_FALLBACK_MODEL || 'google/gemma-4-31b-it:free'

function _apiKey() {
  return process.env.VISION_LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || ''
}

function enabled() {
  const flag = (process.env.VISUAL_BRIEFING || 'on').toLowerCase()
  return flag !== 'off' && flag !== '0' && !!_apiKey()
}

function _month() {
  return new Date().toISOString().substring(0, 7)
}

function _readUsage() {
  const def = { current_month: _month(), count: 0 }
  try {
    const file = _usageFile()
    if (!fs.existsSync(file)) return def
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.current_month !== _month()) return def
    return data
  } catch (e) {
    return def
  }
}

function _budgetOkAndIncrement() {
  try {
    const usage = _readUsage()
    if (usage.count >= MAX_MONTHLY) {
      logger.debug(`[VISUAL-BRIEF] Quota mensuel atteint (${usage.count}/${MAX_MONTHLY}) — briefing ignoré`)
      return false
    }
    usage.count++
    try {
      const file = _usageFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(usage, null, 2), 'utf8')
    } catch (we) {
      logger.debug(`[VISUAL-BRIEF] usage write failed: ${we.message}`)
    }
    return true
  } catch (e) {
    return false
  }
}

function _buildPrompt(match, nTiles) {
  const home = match.homeTeam || match.home || 'Domicile'
  const away = match.awayTeam || match.away || 'Extérieur'
  const league = match.league || match.tournament_name || ''
  return (
    `Tu es analyste football. Voici ${nTiles} capture(s) d'écran (pages Wikipédia / Sofascore) ` +
    `concernant le match ${home} vs ${away}${league ? ` (${league})` : ''}. ` +
    `En 3 puces courtes en français, retiens UNIQUEMENT ce que les visuels apportent pour le ` +
    `pronostic : forme récente, effectif/blessures notables, historique. ` +
    `Si une capture est illisible ou hors-sujet, dis-le en une puce. Pas de verbiage.`
  )
}

async function _postVision(content, model) {
  const res = await axios.post(
    `${VISION_BASE_URL}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 320,
      temperature: 0.3,
    },
    {
      headers: { Authorization: `Bearer ${_apiKey()}` },
      timeout: 60000,
    }
  )
  const msg =
    res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message
      ? res.data.choices[0].message
      : null
  return msg && msg.content ? String(msg.content).trim() : null
}

/**
 * @param {object} match  { homeTeam, awayTeam, league }
 * @param {object} context visual_context (tiles avec .path local)
 * @returns {Promise<string|null>} briefing FR ou null
 */
async function generateBriefing(match, context) {
  if (!enabled() || !match || !context) return null
  const candidates = (context.tiles || []).filter(
    (t) =>
      t &&
      ((t.path && fs.existsSync(t.path)) ||
        (t.source === 'wikipedia' && t.article_id != null && t.tile_index != null))
  )
  const tiles = candidates.slice(0, 3)
  if (!tiles.length) return null
  if (!_budgetOkAndIncrement()) return null

  let content = null
  try {
    const pixelrag = require('./pixelragService')
    content = [{ type: 'text', text: _buildPrompt(match, tiles.length) }]
    for (const t of tiles) {
      let b64 = null
      if (t.path && fs.existsSync(t.path)) {
        b64 = fs.readFileSync(t.path).toString('base64')
      } else {
        // Tuile wiki sans copie locale (recherche live) -> fetch à la volée.
        const buf = await pixelrag.getTile(t.article_id, t.tile_index, t.chunk_index || 0)
        if (buf) b64 = buf.toString('base64')
      }
      if (!b64) continue
      const mime = /\.jpe?g$/i.test(t.path || '') ? 'image/jpeg' : 'image/png'
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } })
    }
  } catch (e) {
    logger.warn(`⚠️ [VISUAL-BRIEF] préparation images échouée: ${e.message}`)
    return null
  }
  if (!content || content.length < 2) return null

  let briefing = null
  try {
    briefing = await _postVision(content, VISION_MODEL)
  } catch (e) {
    const status = e.response && e.response.status
    if (status === 429 && VISION_FALLBACK_MODEL && VISION_FALLBACK_MODEL !== VISION_MODEL) {
      logger.debug(`[VISUAL-BRIEF] ${VISION_MODEL} saturé (429) -> fallback ${VISION_FALLBACK_MODEL}`)
      try {
        briefing = await _postVision(content, VISION_FALLBACK_MODEL)
      } catch (e2) {
        logger.warn(`⚠️ [VISUAL-BRIEF] fallback vision indisponible: ${e2.message}`)
      }
    } else {
      logger.warn(`⚠️ [VISUAL-BRIEF] lecteur vision indisponible: ${e.message}`)
    }
  }
  if (briefing) logger.info(`[VISUAL-BRIEF] briefing généré (${tiles.length} tuile(s), ${briefing.length} car.)`)
  return briefing
}

module.exports = { generateBriefing, enabled }
