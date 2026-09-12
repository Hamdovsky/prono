/**
 * dashboardFilters.js — logique pure de filtrage du Dashboard (testable sans
 * React). Extrait des corrections E18 :
 *  - FILTRE LIGUE : activeLeague était réglé par la Sidebar mais JAMAIS
 *    appliqué à la liste (clic ligue = effet nul). La sélection peut être un
 *    keywords[0] de ligue épinglée/MENA (Sidebar:499/553) ou le nom brut d'une
 *    ligue dynamique (Sidebar:520, id = name). Les deux sont résolus.
 *  - COMPTEURS D'ONGLETS : calculés sur la liste de BASE (date + recherche +
 *    ligue, sans filtre marché) pour ne plus varier quand on change d'onglet.
 */
import { computeRawLines, marketBannerFromLines } from '../utils/matchAnalysis'
import { ALL_LEAGUE_DEFS } from '../data/leagues'

export const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

// ── Recherche (insensible accents/casse, équipes + ligue) ──
export const searchMatches = (m, query) => {
  if (!query) return true
  const q = norm(query)
  return (
    norm(m?.homeTeam).includes(q) ||
    norm(m?.awayTeam).includes(q) ||
    norm(m?.league || m?.tournament_name).includes(q)
  )
}

// ── Filtrage ligue ──
export function leagueKeywords(selection) {
  const s = norm(selection)
  for (const def of ALL_LEAGUE_DEFS) {
    if (def.keywords.length && norm(def.keywords[0]) === s) {
      return def.keywords.map(norm)
    }
  }
  return [s]
}

export const leagueMatches = (m, selection) => {
  if (!selection || selection === 'ALL') return true
  const lg = norm(m?.league || m?.tournament_name)
  if (!lg) return false
  return leagueKeywords(selection).some((k) => lg.includes(k))
}

// ── Raw lines (cache par référence d'objet, importé du Dashboard) ──
const rawLinesCache = new WeakMap()
export const toRawLines = (m) => {
  if (!m) return []
  const cached = rawLinesCache.get(m)
  if (cached) return cached
  const lines = computeRawLines(m)
  rawLinesCache.set(m, lines)
  return lines
}

// ── Onglets marchés : pick jouable = confiance >= seuil par marché ──
export const MARKET_MIN_PCT = { win: 55, ou: 55, btts: 55, ht: 70 }
export const MARKET_CELLS = {
  ou: [4, 11],
  win: [5, 10],
  btts: [3],
  ht: [6],
  corners: [7, 12],
}
export const marketPct = (r, market) => marketBannerFromLines(r, market)?.pct || 0
export const hasMarketPrediction = (r, market) => {
  if (!r) return false
  if (market === 'corners') return MARKET_CELLS.corners.some((i) => r[i] && r[i] !== '--')
  return marketPct(r, market) >= (MARKET_MIN_PCT[market] ?? 55)
}
export const MARKET_TABS = ['ou', 'win', 'btts', 'ht', 'corners']

/**
 * Compteurs d'onglets sur la liste de BASE (sans filtre marché) — fixes quand
 * on change d'onglet.
 */
export function computeChipCounts(list) {
  const counts = {}
  for (const m of list || []) {
    let r = null
    try {
      r = toRawLines(m)
    } catch {
      r = null
    }
    for (const f of MARKET_TABS) {
      if (hasMarketPrediction(r, f)) counts[f] = (counts[f] || 0) + 1
    }
  }
  return counts
}

/** Liste de base : recherche + ligue (le filtre temporel reste au Dashboard). */
export const applyBaseFilters = (list, { searchQuery, activeLeague }) =>
  (list || []).filter((m) => searchMatches(m, searchQuery) && leagueMatches(m, activeLeague))

/** Filtre marché (onglet actif). */
export const applyMarketFilter = (list, dominantFilter) => {
  if (!dominantFilter || dominantFilter === 'ALL') return list
  return (list || []).filter((m) => {
    let r = null
    try {
      r = toRawLines(m)
    } catch {
      r = null
    }
    return hasMarketPrediction(r, dominantFilter)
  })
}
