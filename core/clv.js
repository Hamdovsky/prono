/**
 * clv — resolveur PUR de la cote de CLOTURE d'un match. Sans dependance DB/reseau.
 *
 * Regle d'or du CLV : la "closing line" est la DERNIERE cote connue AVANT LE COUP D'ENVOI
 * (kickoff). Un snapshot enregistre APRES le kickoff (cote LIVE en-jeu) n'est PAS une
 * cloture pre-match et ne doit jamais servir de reference.
 *
 * rows : liste DEJA triee du plus recent au plus ancien (ORDER BY id DESC), chaque
 *   element { odds_home, odds_draw, odds_away, timestamp (ms), type }.
 * startTs : kickoff en millisecondes (>0) ou 0/null si inconnu.
 * Retourne la ligne de cloture, ou null si aucune n'est anterieure au kickoff.
 */
function pickClosingSnapshot(rows, startTs) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  if (!(Number(startTs) > 0)) return rows[0] // kickoff inconnu -> comportement historique (dernier)
  for (const r of rows) {
    const t = Number(r && r.timestamp) || 0
    if (t > 0 && t <= startTs) return r
  }
  return null // uniquement des snapshots post-kickoff -> pas de cloture fiable
}

module.exports = { pickClosingSnapshot }
