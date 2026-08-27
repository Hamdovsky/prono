'use strict';
/**
 * VALIDATOR + CANONICAL MODEL — garde-fous stricts. AUCUNE cote/marche n'est
 * inventee. Un marche sans cote valide ou sans ligne coherente est droppe.
 */
const { lookup } = require('./registry');

const VALID_PERIODS = new Set(['full_time', 'first_half', 'second_half']);

function _validOdds(o) {
  return o !== null && o !== undefined && typeof o === 'number' && o >= 1.0 && isFinite(o);
}

/**
 * @returns {Array} liste de CanonicalMarketModel (un par outcome valide)
 *          ou [] si le marche est invalide.
 */
function validateAndBuild(norm) {
  if (norm.market_id === 'unknown') {
    // Conservé pour inspection mais exclu du flux de pari
    return norm.outcomes
      .filter((o) => _validOdds(o.odds))
      .map((o) => _toCanonical(norm, o.selection || 'unknown', o.odds, false));
  }
  const def = lookup(norm.market_id);
  const out = [];
  for (const o of norm.outcomes) {
    if (!_validOdds(o.odds)) continue; // cote absente/invalide -> on skip, on n'invente pas
    if (def.type === 'over_under' && norm.line == null) continue; // ligne requise
    if (['over', 'under'].includes(o.selection) && norm.line == null) continue;
    const usable = o.selection != null && norm.confidence >= 0.6;
    out.push(_toCanonical(norm, o.selection, o.odds, usable));
  }
  return out;
}

function _toCanonical(norm, selection, odds, usable) {
  return {
    source: norm.source,
    event_id: norm.event_id || norm.raw_market_id || null,
    raw_market_id: norm.raw_market_id,
    raw_market_name: norm.raw_market_name,
    market_id: norm.market_id,
    market_category: norm.market_category,
    market_type: norm.market_type,
    line: norm.line,
    selection,
    handicap: norm.handicap,
    period: norm.period,
    odds,
    confidence: norm.confidence,
    detected_by: norm.detected_by,
    usable, // false => conserve mais ne pas parier dessus
    metadata: {},
  };
}

module.exports = { validateAndBuild, _validOdds };
