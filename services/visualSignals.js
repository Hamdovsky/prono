const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

// Signaux visuels structurés (lecteur PixelRAG -> engine).
// Fonctions pures : parse tolérant du JSON du lecteur, injection COMBLANTE
// (ne renseigne que les champs où les news sont muettes), audit JSONL.

// mapping signal vision -> champ match_obj consommé par l'engine
// (prediction_engine.py KEY_ABSENCES_VETO, xg_engine.py apply_squad_intelligence)
const VISUAL_FIELD_MAP = {
  missing_star_home: 'is_missing_star',
  missing_star_away: 'is_missing_star_away',
  missing_gk_home: 'is_missing_gk',
  missing_gk_away: 'is_missing_gk_away',
}

// Seuil minimal de confiance du lecteur pour influencer un verdict.
const SIGNAL_MIN_CONFIDENCE = parseFloat(process.env.VISUAL_SIGNAL_MIN_CONFIDENCE || '0.55')

/**
 * Parse tolérant de la réponse du lecteur vision : extrait le premier objet JSON,
 * normalise/clampe les champs. Retourne null si pas de JSON exploitable.
 */
function parseSignals(raw) {
  if (!raw || typeof raw !== 'string') return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj = null
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch (e) {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const flag = (v) => (Number(v) >= 1 ? 1 : 0)
  let conf = Number(obj.confidence)
  if (!(conf >= 0)) conf = 0
  conf = Math.min(1, Math.max(0, conf))
  return {
    briefing: String(obj.briefing || '').trim(),
    missing_star_home: flag(obj.missing_star_home),
    missing_star_away: flag(obj.missing_star_away),
    missing_gk_home: flag(obj.missing_gk_home),
    missing_gk_away: flag(obj.missing_gk_away),
    form_home: String(obj.form_home || '').slice(0, 40),
    form_away: String(obj.form_away || '').slice(0, 40),
    h2h_note: String(obj.h2h_note || '').slice(0, 200),
    confidence: conf,
  }
}

/**
 * Injection comblante : ne pose un flag visuel dans matchData que si la source
 * news est muette (null/undefined/0 côté match) ET que la confiance du lecteur
 * suffit. Ne remplace JAMAIS une info news. Retourne la liste des champs posés.
 */
function applyGapFill(matchData, match, signals) {
  if (!matchData || !signals || !(signals.confidence >= SIGNAL_MIN_CONFIDENCE)) return []
  const filled = []
  for (const [sig, field] of Object.entries(VISUAL_FIELD_MAP)) {
    if (Number(signals[sig]) !== 1) continue
    const newsValue = match ? match[field] : null
    if (newsValue === 1 || newsValue === true) continue
    matchData[field] = 1
    filled.push(field)
  }
  if (filled.length) {
    logger.info(`[VISUAL-SIGNAL] ${filled.join(',')} posés par le lecteur (conf ${signals.confidence})`)
  }
  return filled
}

const AUDIT_FILE = path.resolve(__dirname, '../data/visual_signal_audit.jsonl')

/**
 * Audit persistant (JSONL) : qui a dit quoi, ce que ça a modifié, ET le verdict
 * produit — base de la boucle d'évaluation (scripts/visual_signal_stats.py) qui
 * mesure le taux de réussite avec vs sans signal visuel.
 */
function auditSignal(matchId, signals, filled, outcome = {}) {
  try {
    fs.appendFileSync(
      AUDIT_FILE,
      JSON.stringify({
        ts: Date.now(),
        match_id: String(matchId),
        signals,
        filled: filled || [],
        verdict: outcome.verdict != null ? outcome.verdict : null,
        confidence: outcome.confidence != null ? outcome.confidence : null,
        probs: outcome.probs || null,
      }) + '\n',
      'utf8'
    )
  } catch (e) {
    logger.debug(`[VISUAL-SIGNAL] audit write failed: ${e.message}`)
  }
}

module.exports = {
  VISUAL_FIELD_MAP,
  SIGNAL_MIN_CONFIDENCE,
  parseSignals,
  applyGapFill,
  auditSignal,
  AUDIT_FILE,
}
