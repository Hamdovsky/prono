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
import { matchHasFavorite } from './favorites'

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
export const MARKET_MIN_PCT = { win: 55, ou: 55, btts: 55, ht: 70, combo: 40 }
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
export const MARKET_TABS = ['ou', 'win', 'btts', 'ht', 'corners', 'combo']

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

/**
 * Liste de base : recherche + ligue + favoris (le filtre temporel reste au
 * Dashboard).
 */
export const applyBaseFilters = (
  list,
  { searchQuery, activeLeague, onlyFavorites = false, favorites = [] } = {}
) =>
  (list || []).filter(
    (m) =>
      searchMatches(m, searchQuery) &&
      leagueMatches(m, activeLeague) &&
      (!onlyFavorites || matchHasFavorite(m, favorites))
  )

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

// ── Filtres qualité (E20-B) : cotes réelles et veto du moteur ──
export const hasRealOdds = (m) =>
  parseFloat(m?.odds_home) > 1 && parseFloat(m?.odds_draw) > 1 && parseFloat(m?.odds_away) > 1
export const hasVeto = (m) =>
  !!m?.market_divergence?.flagged ||
  /no.?bet/i.test(String(m?.verdict || '')) ||
  /no_bet|no bet/i.test(String(m?.status || ''))
export const applyQualityFilters = (list, { onlyRealOdds = false, hideNoBet = false } = {}) =>
  (list || []).filter(
    (m) => (!onlyRealOdds || hasRealOdds(m)) && (!hideNoBet || !hasVeto(m))
  )

// ── État des filtres <-> URL (E19 : partageables et résistants au refresh) ──
import { VALID_SORTS } from './tableColumns'

export const VALID_DATES = ['Today', 'Tomorrow', 'Next 3 Days', 'Next 7 Days']
export const VALID_MARKETS = ['ALL', 'ou', 'win', 'btts', 'ht', 'corners', 'combo']

export function parseFilterSearch(search) {
  const p = new URLSearchParams(search || '')
  const date = p.get('date')
  const marche = p.get('marche')
  const sort = p.get('sort')
  const dir = p.get('dir')
  const sortBy =
    sort && VALID_SORTS.includes(sort) && (dir === 'asc' || dir === 'desc')
      ? { key: sort, dir }
      : null
  return {
    activeLeague: p.get('ligue') || 'ALL',
    activeDate: VALID_DATES.includes(date) ? date : 'Today',
    dominantFilter: VALID_MARKETS.includes(marche) ? marche : 'ALL',
    searchQuery: p.get('q') || '',
    onlyRealOdds: p.get('odds') === '1',
    hideNoBet: p.get('clean') === '1',
    onlyFavorites: p.get('fav') === '1',
    matchId: p.get('match') || null,
    sortBy,
  }
}

/** Sérialise les filtres non-par-défaut en querystring ('' si aucun). */
export function buildFilterSearch({
  activeLeague = 'ALL',
  activeDate = 'Today',
  dominantFilter = 'ALL',
  searchQuery = '',
  onlyRealOdds = false,
  hideNoBet = false,
  onlyFavorites = false,
  matchId = null,
  sortBy = null,
} = {}) {
  const p = new URLSearchParams()
  if (activeLeague && activeLeague !== 'ALL') p.set('ligue', activeLeague)
  if (activeDate && activeDate !== 'Today') p.set('date', activeDate)
  if (dominantFilter && dominantFilter !== 'ALL') p.set('marche', dominantFilter)
  if (searchQuery) p.set('q', searchQuery)
  if (onlyRealOdds) p.set('odds', '1')
  if (hideNoBet) p.set('clean', '1')
  if (onlyFavorites) p.set('fav', '1')
  if (matchId) p.set('match', String(matchId))
  if (sortBy && sortBy.key && VALID_SORTS.includes(sortBy.key)) {
    p.set('sort', sortBy.key)
    p.set('dir', sortBy.dir === 'desc' ? 'desc' : 'asc')
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ── Tri cliquable sur les en-têtes (E63) ──
// `sortBy = { key, dir }` ou `null` (= tri par défaut "opportunité" du Dashboard).
// `key` ∈ VALID_SORTS. Données manquantes -> envoyées en fin de liste.
const timeOf = (m) => {
  const t = Number(m?.startTimestamp) || 0
  if (!t) return NaN
  return t > 1e11 ? t : t * 1000
}
const leagueOf = (m) => norm(m?.league || m?.tournament_name || '')
const topPctOf = (m) => {
  const raw = toRawLines(m)[14] || ''
  const v = parseFloat(String(raw).split('|')[1])
  return Number.isFinite(v) ? v : NaN
}
const marketPctOf = (m, market) => {
  const v = marketPct(toRawLines(m), market)
  return Number.isFinite(v) && v > 0 ? v : NaN
}
const sortValue = (m, key) => {
  switch (key) {
    case 'time': return timeOf(m)
    case 'league': return leagueOf(m)
    case 'top': return topPctOf(m)
    case 'win': return marketPctOf(m, 'win')
    case 'ou': return marketPctOf(m, 'ou')
    case 'btts': return marketPctOf(m, 'btts')
    case 'ht': return marketPctOf(m, 'ht')
    case 'corners': return marketPctOf(m, 'corners')
    case 'combo': return marketPctOf(m, 'combo')
    default: return NaN
  }
}

export function applySort(list, sortBy) {
  if (!Array.isArray(list) || !sortBy || !sortBy.key) return list || []
  const { key, dir } = sortBy
  const mult = dir === 'desc' ? -1 : 1
  const isStr = key === 'league'
  const arr = [...list]
  arr.sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (isStr) {
      const sa = String(va), sb = String(vb)
      if (sa === sb) return 0
      return mult * sa.localeCompare(sb)
    }
    const aNa = !Number.isFinite(va)
    const bNa = !Number.isFinite(vb)
    if (aNa && bNa) return 0
    if (aNa) return 1
    if (bNa) return -1
    if (va < vb) return -1 * mult
    if (va > vb) return 1 * mult
    return 0
  })
  return arr
}

// ── Regroupement par tranche horaire (E65) ──
// Pour scannner une longue liste : on coupe par jour + moment de la journée
// ("Aujourd'hui · Matin", "Demain · Soir"…). Renvoie une liste aplatie
// [{type:'section',label,count} | {type:'match',match,key}] que la grille
// virtualisée rend avec une hauteur variable (react-window v2).
const dateKey = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const partOfDay = (hour) => {
  if (hour < 12) return 'Matin'
  if (hour < 18) return 'Après-midi'
  if (hour < 22) return 'Soir'
  return 'Nuit'
}
const shortDate = (d) =>
  d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' })

export function buildGroupedByTime(matches, now = Date.now()) {
  const list = Array.isArray(matches) ? matches : []
  const nowDate = new Date(now)
  const todayKey = dateKey(nowDate)
  const tomorrowDate = new Date(now + 86400000)
  const tomorrowKey = dateKey(tomorrowDate)

  const groups = new Map()
  const noTime = []

  for (const m of list) {
    const t = timeOf(m)
    if (!Number.isFinite(t)) {
      noTime.push(m)
      continue
    }
    const d = new Date(t)
    const dk = dateKey(d)
    const part = partOfDay(d.getHours())
    const dayLabel =
      dk === todayKey ? "Aujourd'hui" : dk === tomorrowKey ? 'Demain' : shortDate(d)
    const label = `${dayLabel} · ${part}`
    const gkey = `${dk}|${part}`
    if (!groups.has(gkey)) {
      groups.set(gkey, { label, sortKey: t, items: [] })
    }
    groups.get(gkey).items.push(m)
  }

  const sortedGroups = [...groups.values()].sort((a, b) => a.sortKey - b.sortKey)
  const flat = []
  let i = 0
  for (const g of sortedGroups) {
    g.items.sort((a, b) => timeOf(a) - timeOf(b))
    flat.push({
      type: 'section',
      key: `sec-${g.sortKey}-${i++}`,
      label: g.label,
      count: g.items.length,
    })
    for (const m of g.items) {
      flat.push({ type: 'match', key: m.id != null ? `m-${m.id}` : `m-idx-${i++}`, match: m })
    }
  }
  if (noTime.length > 0) {
    flat.push({ type: 'section', key: 'sec-noTime', label: 'Sans heure', count: noTime.length })
    for (const m of noTime) {
      flat.push({ type: 'match', key: m.id != null ? `m-${m.id}` : `m-nt-${i++}`, match: m })
    }
  }
  return flat
}

/** Hauteur de la liste virtualisée (somme des hauteurs par ligne, cap 800). */
export const SECTION_ROW_HEIGHT = 32
export const computeGroupedListHeight = (flatList, matchRowHeight, cap = 800) => {
  if (!Array.isArray(flatList) || flatList.length === 0) return 0
  let total = 0
  for (const it of flatList) total += it.type === 'section' ? SECTION_ROW_HEIGHT : matchRowHeight
  return Math.min(total, cap)
}

/** Temps relatif FR (utilisé pour "sync il y a Xs"). */
export const relativeTime = (ts, now = Date.now()) => {
  if (!ts) return 'jamais'
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 5) return "à l'instant"
  if (s < 60) return `il y a ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `il y a ${m} min`
  const h = Math.floor(m / 60)
  return `il y a ${h} h`
}

/** Nom joli d'une sélection de ligue (keywords[0] épinglée/MENA -> name). */
export function leagueDisplayLabel(selection) {
  const s = norm(selection)
  for (const def of ALL_LEAGUE_DEFS) {
    if (def.keywords.length && norm(def.keywords[0]) === s) return def.name
  }
  return selection
}

// ── Bandeau de stats de la vue courante (E21-C) ──
export function computeQualitySummary(list) {
  const out = { total: 0, realOdds: 0, vetoed: 0, cacApplied: 0 }
  for (const m of list || []) {
    out.total++
    if (hasRealOdds(m)) out.realOdds++
    if (hasVeto(m)) out.vetoed++
    if (m?.contextual?.enabled === true) out.cacApplied++
  }
  return out
}

// ── Export CSV de la vue (E21-D) — separateur ';' (Excel FR), echappement RFC ──
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[;",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export const CSV_HEADER = [
  'Ligue', 'Date', 'Domicile', 'Exterieur', 'TOP',
  'BTTS', 'O/U', '1X2', '1er MT', 'Corners', 'Combo',
  'Cote 1', 'Cote X', 'Cote 2', 'Veto', 'CAC dom', 'CAC ext',
]

export function buildCsv(list) {
  const lines = [CSV_HEADER.join(';')]
  for (const m of list || []) {
    let r = []
    try {
      r = toRawLines(m)
    } catch {
      r = []
    }
    const rawTs = Number(m?.startTimestamp) || 0
    const ts = rawTs > 1e11 ? rawTs : rawTs * 1000
    const when = rawTs ? new Date(ts).toLocaleString('fr-FR') : ''
    const top = r[14] ? String(r[14]).split('|').slice(0, 2).join(' ') : ''
    lines.push(
      [
        m?.league || m?.tournament_name || '',
        when,
        m?.homeTeam || '',
        m?.awayTeam || '',
        top,
        r[3] || '',
        r[4] || '',
        r[5] || '',
        r[6] || '',
        r[7] || '',
        r[21] || '',
        m?.odds_home || '',
        m?.odds_draw || '',
        m?.odds_away || '',
        hasVeto(m) ? 'OUI' : '',
        m?.contextual?.enabled ? m.contextual.cac_home : '',
        m?.contextual?.enabled ? m.contextual.cac_away : '',
      ]
        .map(csvCell)
        .join(';')
    )
  }
  return lines.join('\r\n')
}
