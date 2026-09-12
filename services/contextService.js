/**
 * contextService.js — Assemblage du contexte ctx_v1 (carburant du CAC Python)
 *
 * RÔLE : agréger UNIQUEMENT (zéro calcul de coefficient — le CAC vit dans
 * core/contextual.py côté Python, source de vérité). Produit match.context :
 *  - absences   : liste affichable (newsService, déjà fetchée par enrichMatch)
 *  - european_next : prochain match CL/EL/UECL à J+0.5..4.5 (DAO SQLite)
 *  - rest_hours    : heures de repos depuis le dernier match joué (DAO)
 *  - motivation    : label d'enjeu dérivé des zones DMF (MotivationEnrichService)
 *
 * injury_impact reste null : Python le calcule lui-même (calculate_injury_impact
 * sur news_data) pour qu'un seul cerveau produise le chiffre.
 */
const EUROPE_RE = /champions league|europa league|conference league|liga dos campe|copa libertadores|uefa/i
const KNOCKOUT_RE = /knockout|quarter|semi|final|play-?off|1\/8|1\/4|1\/2|phase à élimination|preliminary/i

const toSec = (t) => (Number(t) > 1e11 ? Number(t) / 1000 : Number(t))

const compOf = (fixture) => {
  const s = `${fixture.league || ''} ${fixture.tournament_name || ''}`
  if (/champions league|liga dos campe/i.test(s)) return 'UCL'
  if (/europa league/i.test(s)) return 'UEL'
  if (/conference league/i.test(s)) return 'UECL'
  return 'EURO'
}

const motivationLabel = (match, side) => {
  const zone = String(match[`${side}_zone`] || '')
  const league = String(match.league || '').toLowerCase()
  if (/friendly|amicaux/i.test(league)) return 'FRIENDLY'
  if (/title/i.test(zone)) return 'TITLE'
  if (/relegation/i.test(zone)) return 'RELEGATION'
  if (/europe/i.test(zone)) return 'EUROPE_RACE'
  if (/dead zone/i.test(zone)) return 'DEAD_RUBBER'
  return 'STANDARD'
}

const normalizeAbsences = (injuries) => {
  if (!Array.isArray(injuries)) return []
  return injuries
    .slice(0, 12)
    .map((it) =>
      typeof it === 'string'
        ? { player: it, position: '', status: 'unavailable' }
        : {
            player: it.player || it.name || '',
            position: it.position || '',
            status: it.status || 'unavailable',
          }
    )
    .filter((it) => it.player)
}

/**
 * @param {object} match       payload enrichMatch (startTimestamp s ou ms)
 * @param {object|null} newsIntel résultat newsService.getMatchIntelligence
 * @param {object} database    façade core/database (méthodes absentes en mode PG -> skip)
 */
async function buildMatchContext(match, newsIntel, database) {
  const ts = toSec(match.startTimestamp)
  if (!ts) return null
  const teams = {}
  for (const side of ['home', 'away']) {
    const name = match[`${side}Team`]
    let europeanNext = null
    let restHours = null
    try {
      if (name && database && typeof database.getUpcomingFixturesByTeam === 'function') {
        const fixtures = await database.getUpcomingFixturesByTeam(name, ts + 43200, ts + 4.5 * 86400)
        const euro = (fixtures || []).find(
          (f) =>
            EUROPE_RE.test(`${f.league || ''} ${f.tournament_name || ''}`) &&
            Number(f.ts) > ts + 43200
        )
        if (euro) {
          const s = `${euro.league || ''} ${euro.tournament_name || ''}`
          europeanNext = {
            comp: compOf(euro),
            stage: KNOCKOUT_RE.test(s) ? 'knockout' : 'group',
            gap_days: Math.round(((euro.ts - ts) / 86400) * 10) / 10,
          }
        }
      }
      if (name && database && typeof database.getHoursRest === 'function') {
        restHours = await database.getHoursRest(name, ts)
      }
    } catch (e) {
      /* contexte optionnel : jamais bloquant */
    }
    teams[side] = {
      absences: normalizeAbsences(newsIntel?.[side]?.injuries),
      injury_impact: null,
      european_next: europeanNext,
      rest_hours: restHours,
      motivation: motivationLabel(match, side),
    }
  }
  return { schema: 'ctx_v1', generated_at: new Date().toISOString(), teams }
}

module.exports = { buildMatchContext, motivationLabel, normalizeAbsences, EUROPE_RE, KNOCKOUT_RE }
