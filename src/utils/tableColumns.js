/**
 * tableColumns.js — source de vérité UNIQUE des colonnes de la liste desktop
 * (E20). Avant : largeurs dupliquées entre Dashboard.jsx (en-tête, literals)
 * et MatchCard.css (.mc-* width) -> dérive + colonnes décalées par la
 * bannière MEILLEUR PRONOSTIC (enfant flex sans largeur qui volait de la
 * place). Ici : fr proportionnels (somme = 100), injectés en variable CSS
 * --mc-cols partagée par l'en-tête et les cartes.
 */
export const TABLE_COLUMNS = [
  { key: 'info', label: 'MATCH / FORME', fr: 17, min: 140 },
  { key: 'top', label: 'TOP ⭐', fr: 13, min: 90 },
  { key: 'btts', label: 'BTTS', fr: 8, min: 64 },
  { key: 'ou', label: 'O/U LIGNES', fr: 10, min: 70 },
  { key: 'win', label: 'GAGNANT 1X2', fr: 13, min: 90 },
  { key: 'ht', label: 'BUT 1ER MT', fr: 10, min: 70 },
  { key: 'corners', label: 'CORNERS', fr: 8, min: 64 },
  { key: 'htft', label: 'HT/FT', fr: 7, min: 60 },
  { key: 'ah', label: 'AH', fr: 7, min: 60 },
  { key: 'tts', label: 'QUI MARQUE', fr: 7, min: 56 },
]

export const mcColumnsCss = (cols = TABLE_COLUMNS) =>
  cols.map((c) => `${c.fr}fr`).join(' ')

export const MC_COLS_FALLBACK = mcColumnsCss()
