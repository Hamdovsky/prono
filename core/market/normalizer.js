'use strict';
/**
 * NORMALIZER + CLASSIFIER — associe un candidat au MARKET_REGISTRY, extrait
 * line/selection/handicap, assigne category/type, et calcule un score de
 * confiance. Si aucune correspondance -> market_id:"unknown" (conservé).
 */
const { MARKET_REGISTRY, SELECTION_SYNONYMS } = require('./registry');

function _toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

function _matchSelection(def, outcomeName) {
  if (!outcomeName) return null;
  const s = String(outcomeName).toLowerCase().trim();
  for (const [canon, regexes] of Object.entries(def.selections || {})) {
    if (regexes.some((re) => re.test(s))) return canon;
  }
  // fallback synonymes
  const syn = SELECTION_SYNONYMS[s] || SELECTION_SYNONYMS[s.replace(/[^a-z0-9]/gi, '')];
  if (syn && def.selections[syn]) return syn;
  return null;
}

function normalize(cand) {
  const name = cand.rawName || cand.name || '';
  const id = cand.rawId || cand.id || null;

  for (const [mid, def] of Object.entries(MARKET_REGISTRY)) {
    for (const re of def.aliases) {
      const m = name.match(re);
      if (!m) continue;
      // Extraction ligne : 1er groupe capturant un nombre, sinon defaultLine
      let line = def.defaultLine != null ? def.defaultLine : null;
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined && m[i] !== '') {
          const n = _toNum(m[i]);
          if (n !== null) { line = n; break; }
        }
      }
      // Pour team_goals / ah, le cote "home/away" est dans la selection
      const outcomes = (cand.outcomes || []).map((o) => ({
        name: o.name,
        odds: _toNum(o.odds),
        selection: _matchSelection(def, o.name),
      }));
      const hasValidSel = outcomes.some((o) => o.selection);
      const confidence = hasValidSel ? (m.index === 0 ? 0.97 : 0.9) : 0.6;
      return {
        source: cand.source,
        raw_market_id: id,
        raw_market_name: name,
        market_id: mid,
        market_category: def.category,
        market_type: def.type,
        period: def.period,
        line,
        selection: null, // rempli par outcome dans le flux
        handicap: def.needsHandicap ? line : null,
        outcomes,
        confidence,
        detected_by: cand.detected_by || 'adapter',
      };
    }
  }
  // Aucune correspondance : conservé comme unknown (JAMAIS d'invention)
  return {
    source: cand.source,
    raw_market_id: id,
    raw_market_name: name,
    market_id: 'unknown',
    market_category: 'unknown',
    market_type: 'unknown',
    period: 'unknown',
    line: null,
    selection: null,
    handicap: null,
    outcomes: (cand.outcomes || []).map((o) => ({ name: o.name, odds: _toNum(o.odds), selection: null })),
    confidence: 0.0,
    detected_by: cand.detected_by || 'adapter',
  };
}

module.exports = { normalize, _matchSelection };
