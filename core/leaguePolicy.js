/**
 * leaguePolicy — Audit étape 1 : désambiguïsation des noms de ligues génériques.
 *
 * Problème constaté (2026-08-24) : la source livescore écrase le championnat
 * par son seul nom local. Résultat : Torpedo Zhodino (Biélorussie) étiqueté
 * « Premier League », Botafogo (Brésil) « Serie A », Kuwait SC « Premier
 * League », etc. → pollution des stats par ligue et routage XGBoost top-5
 * erroné pour des matchs qui ne sont PAS des top-5 européens.
 *
 * Règle : un label générique Top-5 n'est valable QUE pour son pays officiel.
 * Sinon, le match est réétiqueté « {Pays} - {label} » (honnête, explicite,
 * et automatiquement exclu des traitements spécifiques top-5).
 */

const GENERIC_TOP5 = {
  'Premier League': 'England',
  LaLiga: 'Spain',
  'Serie A': 'Italy',
  Bundesliga: 'Germany',
  'Ligue 1': 'France',
}

function extractCountry(m) {
  if (!m) return ''
  if (m.country && typeof m.country === 'string') return m.country.trim()
  let fd = m.fullData
  if (typeof fd === 'string') {
    try {
      fd = JSON.parse(fd)
    } catch (_) {
      fd = null
    }
  }
  if (fd && typeof fd === 'object') {
    if (fd.country && typeof fd.country === 'string') return fd.country.trim()
    if (fd.category_name && typeof fd.category_name === 'string') return fd.category_name.trim()
    if (fd.category && typeof fd.category === 'object' && fd.category.name)
      return String(fd.category.name).trim()
  }
  if (m.category_name && typeof m.category_name === 'string') return m.category_name.trim()
  return ''
}

/**
 * @param {string} league label brut de la source
 * @param {string} country pays extrait (fullData/category)
 * @returns {{league:string, changed:boolean}} label corrigé ou inchangé
 */
function resolveTrueLeague(league, country) {
  const official = GENERIC_TOP5[league]
  if (!official || !country) return { league, changed: false }
  const c = country.toLowerCase()
  if (c === official.toLowerCase()) return { league, changed: false }
  return { league: `${country} - ${league}`, changed: true }
}

/**
 * Hook à appeler AVANT toute écriture en base. Mute m.league si nécessaire.
 * @returns {{changed:boolean, from?:string, to?:string, country:string}}
 */
function applyLeaguePolicy(m) {
  try {
    const country = extractCountry(m)
    const res = resolveTrueLeague(m.league, country)
    if (res.changed) {
      const from = m.league
      m.league = res.league
      return { changed: true, from, to: res.league, country }
    }
    return { changed: false, country }
  } catch (_) {
    // La politique de ligues ne doit jamais casser l'insertion.
    return { changed: false, country: '' }
  }
}

module.exports = { applyLeaguePolicy, resolveTrueLeague, extractCountry, GENERIC_TOP5 }
