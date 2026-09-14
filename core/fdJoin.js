/**
 * fdJoin — helpers purs pour joindre un match local a une ligne de resultats
 * football-data.co.uk (CSV gratuits, sans cle, non-bloques) et en extraire les
 * cotes de cloture 1X2. Sans dependance DB/reseau -> testable unitairement.
 * Reutilise par scripts/backfill_odds_footballdata.js (E29 Rentabilite, Etape 1.3).
 */
const path = require('path')
const REPO = path.join(__dirname, '..')

const STOP = new Set(['fc','cf','sc','ac','afc','cfc','sk','fk','bk','if','aifc','sv','tsv','fsv','us','as','ss','ssc','rc','cd','ca','cp','ud','de','bc','club','deportivo','city','town','1','07','1899','1900','1907','1909'])
// Table d'alias canonique du depot (config/teamAliases.js) -> meme cle pour les
// variantes source (FD 'Man United' vs livescore 'Manchester United', etc.).
const { TEAM_ALIAS_MAP } = require(REPO + '/config/teamAliases')

function normTeam(name) {
  const raw = String(name || '').trim()
  const canonical = (TEAM_ALIAS_MAP && (TEAM_ALIAS_MAP[raw] || TEAM_ALIAS_MAP[raw.replace(/\s+/g, ' ')])) || raw
  return canonical
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\./g, ' ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .split(' ').filter((t) => t && !STOP.has(t)).join(' ')
}

// 'DD/MM/YY' | 'DD/MM/YYYY' | 'YYYY-MM-DD...' -> 'YYYY-MM-DD' ou null.
function normDate(v) {
  const s = String(v || '').trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const [, d, mo, y] = m
    const yy = y.length === 4 ? y : '20' + y
    return `${yy}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

// Cle de jointure normalisee.
function joinKey(dateISO, home, away) {
  return `${dateISO}|${normTeam(home)}|${normTeam(away)}`
}

// Score final coherent ? (garde ANTI-faux-match : n'accepte la cote que si le
// score final CSV == score final en base). CSV vide/absent ('' / null) = NON
// parseable -> false (un score FD manquant ne doit JAMAIS valider une jointure).
function ftCoherent(csvH, csvA, sh, sa) {
  const p = (v) => (v == null || String(v).trim() === '' ? NaN : Number(v))
  const a = [p(csvH), p(csvA), p(sh), p(sa)]
  if (a.some((x) => !Number.isFinite(x))) return false
  return a[0] === a[2] && a[1] === a[3]
}

// Extrait les cotes 1X2 de cloture : priorite B365 -> Avg -> Pinnacle.
// Retourne {home,draw,away,source} ou null si aucune triplete valide (>1).
function pickClosingOdds(row) {
  const g = (k) => { const v = Number(row[k]); return Number.isFinite(v) && v > 1 ? v : null }
  const chains = [
    { s: 'footballdata_b365', keys: ['B365H', 'B365D', 'B365A'] },
    { s: 'footballdata_avg', keys: ['AvgH', 'AvgD', 'AvgA'] },
    { s: 'footballdata_psn', keys: ['PSH', 'PSD', 'PSA'] },
  ]
  for (const c of chains) {
    const [h, d, a] = c.keys.map(g)
    if (h && d && a) return { home: h, draw: d, away: a, source: c.s }
  }
  return null
}

module.exports = { normTeam, normDate, joinKey, ftCoherent, pickClosingOdds }
