'use strict';
/**
 * DISCOVERY ENGINE — parcours recursif d'un payload source pour repérer TOUTE
 * structure "market-like" (objet avec outcomes[] + odds), meme inconnue.
 * Remonte les inconnus avec detected_by:"discovery" pour analyse/extension.
 */

function _isOutcome(o) {
  if (!o || typeof o !== 'object') return false;
  return (
    o.odds !== undefined || o.price !== undefined || o.decimal !== undefined ||
    o.odd !== undefined || o.value !== undefined || o.probability !== undefined
  );
}

function _collectOutcomes(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.outcomes)) return node.outcomes;
  if (Array.isArray(node.selections)) return node.selections;
  if (Array.isArray(node.bets)) return node.bets;
  if (Array.isArray(node.markets)) return node.markets;
  if (Array.isArray(node.runners)) return node.runners; // exchange format
  return null;
}

/**
 * @param {object} node  payload brut ou sous-noeud
 * @param {string} path  chemin pour traçabilité
 * @param {Array}  out   accumulateur
 */
function discover(node, path = '$', out = []) {
  if (!node || typeof node !== 'object') return out;
  const outcomes = _collectOutcomes(node);
  if (Array.isArray(outcomes) && outcomes.length > 0 && outcomes.some(_isOutcome)) {
    out.push({
      path,
      rawName: node.name || node.marketName || node.label || node.title || null,
      rawId: node.id || node.marketId || node.key || null,
      outcomes: outcomes.filter(_isOutcome).map((o) => ({
        name: o.name || o.selection || o.label || o.side || null,
        odds: _num(o.odds ?? o.price ?? o.decimal ?? o.odd ?? o.value),
      })),
      detected_by: 'discovery',
    });
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') discover(v, `${path}.${k}`, out);
  }
  return out;
}

function _num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

module.exports = { discover };
