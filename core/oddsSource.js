/**
 * oddsSource — prédicat pur : une SOURCE de cote est-elle un VRAI bookmaker ?
 * Sans dépendance DB/réseau -> testable. Partagé par le filtre de picks
 * (topPicksEngine) et, à terme, le gate CLV / la calibration marché.
 *
 * Contexte (E33, Chantier rentabilité) : des lignes portent des cotes SYNTHE-
 * TIQUES (le modèle renverse ses propres probabilités en "cotes") marquées
 * odds_source='fair_odds_model' / 'default' / 'synthetic' / 'model_league' /
 * 'historical'. Les traiter comme de vraies cotes produit un EV circulaire
 * (modèle contre lui-même) et fausse calibration + CLV. Cette fonction les
 * exclut proprement.
 */

// Sources NON-bookmaker (synthétiques / défaut / modèle). Toute autre chaîne
// non vide (betexplorer, sofascore, footballdata, football_data, ultimate:*,
// oddsapiio, sportmonks, ...) est considérée réelle.
const SYNTHETIC_SOURCES = new Set([
  'fair_odds_model',
  'default',
  'synthetic',
  'model_league',
  'historical',
  'historical+elo',
  'none',
  'non_bookmaker',
  'non_bookmaker:default',
])

function isRealBookmakerSource(src) {
  if (src == null) return false
  const s = String(src).trim().toLowerCase()
  if (s === '') return false
  if (SYNTHETIC_SOURCES.has(s)) return false
  // garde-fau : toute source explicitement préfixée "non_bookmaker" ou "fair_"
  if (s.startsWith('non_bookmaker') || s.startsWith('fair_') || s.startsWith('model_')) return false
  return true
}

// Lit la source d'une ligne de match (colonne odds_source ou fullData), avec la
// même priorité que le persistance : colonne d'abord, puis fullData.odds_source,
// puis fullData.odds.source.
function oddsSourceOf(m, parsedFullData) {
  if (!m) return null
  const fd = parsedFullData || (typeof m.fullData === 'string' ? safeParse(m.fullData) : m.fullData) || {}
  return m.odds_source || fd.odds_source || (fd.odds && fd.odds.source) || null
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

module.exports = { isRealBookmakerSource, oddsSourceOf, SYNTHETIC_SOURCES }
