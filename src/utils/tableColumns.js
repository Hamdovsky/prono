/**
 * tableColumns.js — source de vérité UNIQUE des colonnes de la liste desktop
 * (E20). Avant : largeurs dupliquées entre Dashboard.jsx (en-tête, literals)
 * et MatchCard.css (.mc-* width) -> dérive + colonnes décalées par la
 * bannière MEILLEUR PRONOSTIC (enfant flex sans largeur qui volait de la
 * place). Ici : fr proportionnels (somme = 100), injectés en variable CSS
 * --mc-cols partagée par l'en-tête et les cartes.
 *
 * E62 : chaque colonne porte un `tier` (largeur mini du conteneur, en px, pour
 * l'afficher) et un `group` (regroupement visuel). `columnsForWidth()` filtre
 * selon la largeur RÉELLE mesurée (ResizeObserver, Dashboard) : fini les 10
 * colonnes tassées sous ~1040px — la cause des chevauchements constatés en E61.
 */
export const TABLE_COLUMNS = [
  { key: 'info', label: 'MATCH / FORME', fr: 17, min: 150, tier: 0, group: 'match', sortKey: 'league' },
  { key: 'top', label: 'TOP ⭐', fr: 12, min: 92, tier: 0, group: 'pick', sortKey: 'top' },
  { key: 'btts', label: 'BTTS', fr: 8, min: 62, tier: 860, group: 'odds', sortKey: 'btts' },
  { key: 'ou', label: 'O/U', fr: 11, min: 76, tier: 560, group: 'odds', sortKey: 'ou' },
  { key: 'win', label: 'GAGNANT', fr: 13, min: 96, tier: 560, group: 'odds', sortKey: 'win' },
  { key: 'ht', label: '1RE MT', fr: 9, min: 70, tier: 860, group: 'odds', sortKey: 'ht' },
  { key: 'corners', label: 'CORNERS', fr: 8, min: 62, tier: 860, group: 'odds', sortKey: 'corners' },
  { key: 'combo', label: 'COMBO', fr: 8, min: 62, tier: 860, group: 'odds', sortKey: 'combo' },
  { key: 'htft', label: 'HT/FT', fr: 7, min: 64, tier: 1040, group: 'info', sortKey: null },
  { key: 'ah', label: 'AH', fr: 7, min: 64, tier: 1040, group: 'info', sortKey: null },
  { key: 'tts', label: 'QUI MARQUE', fr: 7, min: 60, tier: 1040, group: 'info', sortKey: null },
]

// Paliers responsive (px de conteneur) : 2 -> 4 -> 8 -> 11 colonnes.
//  < 560  : info + top
// 560-859 : + ou + win
// 860-1039: + btts + ht + corners + combo
//  >= 1040: + htft + ah + tts (tout)
export const COLUMN_WIDTH_TIERS = [0, 560, 860, 1040]

// Sens de tri par défaut quand on clique l'en-tête : % desc, temps/ligue asc.
export const SORT_DEFAULT_DIRS = {
  time: 'asc',
  league: 'asc',
  top: 'desc',
  win: 'desc',
  ou: 'desc',
  btts: 'desc',
  ht: 'desc',
  corners: 'desc',
  combo: 'desc',
}
export const VALID_SORTS = Object.keys(SORT_DEFAULT_DIRS)

export const columnsForWidth = (width, cols = TABLE_COLUMNS) => {
  const w = Number(width) || 0
  return cols.filter((c) => w >= (c.tier || 0))
}

export const mcColumnsCss = (cols = TABLE_COLUMNS) =>
  cols.map((c) => `minmax(0, ${c.fr}fr)`).join(' ')

export const MC_COLS_FALLBACK = mcColumnsCss()

// Vrai pour la 1re colonne de chaque groupe : sert à poser un séparateur
// vertical et à éviter qu'un badge de marché colle visuellement à la colonne
// voisine (E61/E62). L'ordre d'affichage est celui de TABLE_COLUMNS.
export const groupStarts = (cols = TABLE_COLUMNS) => {
  const starts = new Set()
  let prev = null
  for (const c of cols) {
    if (prev !== null && c.group !== prev) starts.add(c.key)
    prev = c.group
  }
  return starts
}
