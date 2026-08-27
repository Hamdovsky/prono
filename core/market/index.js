'use strict';
/**
 * MARKET ENGINE — orchestration :
 *   raw payload -> adapter -> discovery -> normalizer -> validator -> canonical
 * Extensible : ajouter un adapter (nouveau bookmaker) ou une entree registry
 * (nouveau marche) SANS toucher ce fichier.
 */
const { SourceAdapter, promosportAdapter, fdBookmakerAdapter, sofascoreAdapter } = require('./adapter');
const { discover } = require('./discovery');
const { normalize } = require('./normalizer');
const { validateAndBuild } = require('./validator');

const ADAPTERS = {
  promosport: promosportAdapter,
  'football-data': fdBookmakerAdapter,
  sofascore: sofascoreAdapter,
};

function registerAdapter(name, adapter) {
  ADAPTERS[name] = adapter;
}

/**
 * @param {object} raw        payload source brut
 * @param {object} opts
 *   - source: nom de l'adapter a utiliser (ex: 'promosport')
 *   - eventId: id du match pour le modele canonical
 * @returns {Array<CanonicalMarketModel>}
 */
function process(raw, opts = {}) {
  const source = opts.source || (Array.isArray(raw) ? raw[0] && raw[0].source : raw.source);
  const adapter = ADAPTERS[source];
  const results = [];
  const items = Array.isArray(raw) ? raw : [raw];

  for (const item of items) {
    if (adapter) {
      const cand = adapter.toCandidate(item);
      if (cand) {
        cand.event_id = opts.eventId;
        const norm = normalize(cand);
        norm.event_id = opts.eventId;
        results.push(...validateAndBuild(norm));
      }
    }
    // Decouverte recursive (pour les sources qui exposent deja markets[])
    const discovered = discover(item)
      .filter((d) => d.path !== '$')
      .map((d) => ({ source, event_id: opts.eventId, ...d }));
    for (const d of discovered) {
      const norm = normalize(d);
      norm.event_id = opts.eventId;
      results.push(...validateAndBuild(norm));
    }
  }

  // Dedup par (source, market_id, line, selection)
  const seen = new Set();
  const deduped = [];
  for (const m of results) {
    const key = `${m.source}|${m.event_id}|${m.market_id}|${m.line}|${m.selection}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped;
}

module.exports = { process, registerAdapter, ADAPTERS };
