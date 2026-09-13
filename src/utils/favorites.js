/**
 * favorites.js — « Mes équipes » (E21-B), par ÉQUIPE (pas par match) : la
 * sélection survit au refresh et suit le calendrier. Stockage localStorage
 * (store injectable pour les tests — jamais de throw hors navigateur).
 */

export const FAVORITES_KEY = 'hp_favorites'

// Mini-norm local (copy of dashboardFilters.norm) — evite tout cycle d'imports
// dashboardFilters <-> favorites (dashboardFilters importe matchHasFavorite).
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

export function loadFavorites(store) {
  try {
    const s = store || (typeof window !== 'undefined' ? window.localStorage : null)
    if (!s) return []
    const raw = JSON.parse(s.getItem(FAVORITES_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return [...new Set(raw.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
  } catch {
    return []
  }
}

export function saveFavorites(list, store) {
  try {
    const s = store || (typeof window !== 'undefined' ? window.localStorage : null)
    if (!s) return
    s.setItem(FAVORITES_KEY, JSON.stringify(Array.isArray(list) ? list : []))
  } catch {
    /* quota / mode privé : silencieux */
  }
}

/** Bascule une équipe (insensible casse/accents). Retourne la nouvelle liste. */
export function toggleFavorite(team, favorites) {
  const key = norm(team)
  if (!key) return [...favorites]
  const exists = favorites.some((t) => norm(t) === key)
  const next = exists
    ? favorites.filter((t) => norm(t) !== key)
    : [...favorites, String(team).trim()]
  saveFavorites(next)
  return next
}

/** Le match oppose-t-il au moins une équipe favorite ? */
export function matchHasFavorite(m, favorites) {
  if (!favorites?.length || !m) return false
  const home = norm(m.homeTeam)
  const away = norm(m.awayTeam)
  return favorites.some((t) => {
    const k = norm(t)
    return (home && k === home) || (away && k === away)
  })
}
