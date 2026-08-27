'use strict';
/**
 * SOURCE ADAPTER — transforme le format propre a une source/bookmaker en
 * "RawMarketCandidate" generique. Un adapter par source, AUCUNE logique
 * de matching par nom ici (ca reste dans normalizer/registry).
 */

class SourceAdapter {
  constructor(sourceName, mapFn) {
    this.source = sourceName;
    this._map = mapFn;
  }
  toCandidate(raw) {
    try {
      const c = this._map(raw);
      return { source: this.source, ...c };
    } catch (e) {
      return null;
    }
  }
}

// ---- Adaptateurs existants (sources du projet) ----

// Promosport : ne fournit que du 1X2 (probabilites), on le mappe en marche
// match_result avec odds derivees (prob -> cote decimal = 1/prob, NE PAS
// inventer : on garde prob et on calcule la cote implicite pour reference).
const promosportAdapter = new SourceAdapter('promosport', (raw) => ({
  id: raw.id,
  name: 'Match Result',
  outcomes: [
    { name: 'home', odds: raw.homeWinProbability ? 1 / raw.homeWinProbability : null },
    { name: 'draw', odds: raw.drawProbability ? 1 / raw.drawProbability : null },
    { name: 'away', odds: raw.awayWinProbability ? 1 / raw.awayWinProbability : null },
  ],
}));

// football-data.co.uk (format CSV colonnes B365C>, B365CH<, etc.)
// Ici on passe deja des marches extraites (corners/HT) en candidats.
const fdBookmakerAdapter = new SourceAdapter('football-data', (raw) => ({
  id: raw.event_id,
  name: raw.market_name || raw.name,
  outcomes: raw.outcomes, // [{name, odds}]
}));

// Sofascore : payload /event/{id}/odds/{marketId}/featured
// choices = [{ name, decimalValue|fractionalValue }]. Sofascore ne donne PAS le
// nom du marche dans le payload -> on derive un label depuis le marketId via
// SOFASCORE_MARKET_NAMES (ajout d'un ID = nouveau marche, sans rewrite).
const SOFASCORE_MARKET_NAMES = {
  1: 'Match Result',
  5: 'Over/Under 2.5 Goals',
  6: 'Both Teams To Score',
  7: 'Double Chance',
  8: 'Half Time / Full Time',
  9: 'Over/Under 9.5 Corners',
  10: 'Asian Handicap',
  12: 'Team To Score',
  14: 'Over/Under 0.5 Goals (HT)',
  18: 'BTTS & Win',
  19: 'Draw No Bet',
  22: 'BTTS & Over/Under',
};
const sofascoreAdapter = new SourceAdapter('sofascore', (raw) => {
  const featured = raw?.featured;
  const mktId = raw?.marketId != null ? Number(raw.marketId)
    : (raw?.id ? Number(String(raw.id).split(':')[1]) : null);
  const label = (raw?.marketName && !String(raw.marketName).startsWith('sofa_'))
    ? raw.marketName
    : SOFASCORE_MARKET_NAMES[mktId] || '';
  if (!featured) return { id: raw.id, name: label, outcomes: [] };
  const market =
    featured.default ||
    featured.fullTime ||
    (Array.isArray(featured.markets) ? featured.markets[0] : null) ||
    Object.values(featured)[0];
  if (!market) return { id: raw.id, name: label, outcomes: [] };
  let choices = market.choices;
  if (!Array.isArray(choices) && Array.isArray(market.markets)) {
    const inner = market.markets.find((mk) => Array.isArray(mk.choices));
    if (inner) choices = inner.choices;
  }
  if (!Array.isArray(choices)) return { id: raw.id, name: label, outcomes: [] };
  const outcomes = choices
    .map((c) => {
      let val = parseFloat(c.decimalValue);
      if (!val || val <= 1) {
        const raw2 = c.fractionalValue;
        if (typeof raw2 === 'string' && raw2.includes('/')) {
          const [n, d] = raw2.split('/');
          const num = parseFloat(n), den = parseFloat(d);
          if (num && den) val = num / den + 1;
        } else if (raw2 != null) {
          val = parseFloat(raw2);
        }
      }
      return val && val > 1 ? { name: String(c.name || ''), odds: val } : null;
    })
    .filter(Boolean);
  return { id: raw.id, name: label, outcomes };
});

module.exports = { SourceAdapter, promosportAdapter, fdBookmakerAdapter, sofascoreAdapter };
