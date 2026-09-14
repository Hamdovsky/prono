/**
 * archiveMerge — helpers purs d'enrichissement du fullData a l'archivage.
 * Sans dependance DB/reseau -> testable unitairement et partageable par les deux
 * chemins d'archivage (core/db/matches.js SQLite et core/pg_database.js PG).
 *
 * E29 (Rentabilite, Etape 1.1) : l'archivage lisait `SELECT *` mais ne recopiait
 * PAS les colonnes de cotes (odds_home/draw/away, over/under 2.5, btts) dans le
 * fullData archive -> le ROI par marche etait perdu a l'archive (historical
 * fullData odds_home present sur ~251/9750 seulement). On les re-injecte ici,
 * SANS ecraser une valeur deja presente dans le fullData (respect de l'existant).
 */

const ODD_FIELDS = [
  'odds_home',
  'odds_draw',
  'odds_away',
  'odds_over25',
  'odds_under25',
  'odds_btts_yes',
  'odds_btts_no',
  'odds_home_open',
  'odds_draw_open',
  'odds_away_open',
  'odds_source',
]

// Retourne fd enrichi (mutation evitee via copie legere) ; ne fait qu'ajouter les
// cotes presentes dans la ligne r et absentes/nulls dans fd.
function mergeOddsIntoFullData(fd, row) {
  const out = fd && typeof fd === 'object' ? { ...fd } : {}
  if (!row || typeof row !== 'object') return out
  for (const f of ODD_FIELDS) {
    const v = row[f]
    if (v == null || v === '') continue
    if (out[f] == null || out[f] === '') out[f] = v
  }
  return out
}

module.exports = { mergeOddsIntoFullData, ODD_FIELDS }
