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
 *
 * E37 : on fait pareil pour les STATS (ht_score/corners/xg/shots/possession + lien
 * fotmob_id), sinon le HT/corners/xG saisis sur matches sont perdus a l'archive et
 * le ML (train_corners/train_ht/O/U) ne peut pas s'entraainer sur l'historique.
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

// Stats preservees a l'archive (E37) — memes regles COALESCE-safe.
const STATS_FIELDS = [
  'fotmob_id',
  'ht_score_home',
  'ht_score_away',
  'corners_home',
  'corners_away',
  'corners_ht_home',
  'corners_ht_away',
  'home_xg',
  'away_xg',
  'xg_ht_home',
  'xg_ht_away',
  'shots_home',
  'shots_away',
  'shots_on_target_home',
  'shots_on_target_away',
  'possession_home',
  'possession_away',
]

const ALL_FIELDS = [...ODD_FIELDS, ...STATS_FIELDS]

// Retourne fd enrichi (mutation evitee via copie legere) ; ne fait qu'ajouter les
// champs presents dans la ligne r et absents/nulls dans fd.
function mergeOddsIntoFullData(fd, row) {
  const out = fd && typeof fd === 'object' ? { ...fd } : {}
  if (!row || typeof row !== 'object') return out
  for (const f of ALL_FIELDS) {
    const v = row[f]
    if (v == null || v === '') continue
    if (out[f] == null || out[f] === '') out[f] = v
  }
  return out
}

module.exports = { mergeOddsIntoFullData, ODD_FIELDS, STATS_FIELDS, ALL_FIELDS }
