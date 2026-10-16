/**
 * coachFlag.js — signal "nouveau coach" (E119 phase 2).
 *
 * Constat de mesure : la fenetre de matchs regles ne couvre que ~2 mois
 * (2026-08/10) : le bounce n'est PAS mesurable (2-4 tenures exploitables).
 * Ce module expose donc un FLAG informatif (pas un boost) : un coach nomme
 * depuis moins de `windowDays` jours merite prudence, sans effet presume.
 * Le boost viendra quand les donnees accumulees permettront la mesure.
 */
const NEW_COACH_DAYS_DEFAULT = 90

// Variantes de noms rencontres en base vs cles TEAM_SLUGS (minuscules
// normalisees). Source de verite des slugs : TEAM_SLUGS (valueBetEnricher).
const NAME_VARIANTS = {
  'mamelodi sundowns fc': 'mamelodi-sundowns-fc',
  'el zamalek': 'zamalek-sc',
  'mc alger': 'mc-algier',
  'usm alger': 'usm-algier',
  'esperance': 'esperance-tunis',
  'raja casablanca': 'raja-casablanca',
  'wydad casablanca': 'wydad-casablanca',
  'cs sfaxien': 'club-sportif-sfaxien',
  'al ahly': 'el-ahly-kairo',
  'paris sg': 'paris-saint-germain',
  'paris saint-germain': 'paris-saint-germain',
  'inter': 'inter-mailand',
  'internazionale': 'inter-mailand',
  'ac milan': 'ac-mailand',
  'milan': 'ac-mailand',
  'atletico madrid': 'atletico-madrid',
  'atletico de madrid': 'atletico-madrid',
  'bayern munich': 'bayern-munchen',
  'liverpool fc': 'liverpool',
  'arsenal fc': 'arsenal',
  'chelsea fc': 'chelsea',
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bfc\b|\bsc\b|\bac\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Slug TEAM_SLUGS pour un nom d'equipe, ou null. Lazy-require pour garder
 * ce module leger et sans cycle (valueBetEnricher tire fbref/database).
 */
function slugForTeamName(name) {
  const norm = normalizeName(name)
  if (!norm) return null
  if (NAME_VARIANTS[norm]) return NAME_VARIANTS[norm]
  try {
    const { TEAM_SLUGS } = require('../services/valueBetEnricher')
    for (const [key, v] of Object.entries(TEAM_SLUGS || {})) {
      if (normalizeName(key) === norm && v && v.slug) return v.slug
    }
  } catch (_) {}
  return null
}

function daysSince(isoDate, nowMs) {
  if (!isoDate) return null
  const t = Date.parse(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  return Math.floor(((nowMs ?? Date.now()) - t) / 86400000)
}

function isNewCoach(appointedIso, nowMs, windowDays = NEW_COACH_DAYS_DEFAULT) {
  const d = daysSince(appointedIso, nowMs)
  if (d === null || d < 0) return false
  return d <= windowDays
}

/**
 * Coach actuel d'une equipe depuis coach_history.
 * @param {object} db better-sqlite3
 * @param {string} teamSlug
 * @param {number} [nowMs]
 */
function getCoachInfo(db, teamSlug, nowMs, windowDays = NEW_COACH_DAYS_DEFAULT) {
  const row = db
    .prepare(
      `SELECT manager, appointed FROM coach_history
       WHERE team_slug = ? AND ended IS NULL
       ORDER BY checked_at DESC LIMIT 1`
    )
    .get(teamSlug)
  if (!row) return { manager: null, appointed: null, daysSince: null, isNew: false }
  const d = daysSince(row.appointed, nowMs)
  return {
    manager: row.manager,
    appointed: row.appointed,
    daysSince: d,
    isNew: d !== null && d >= 0 && d <= windowDays,
  }
}

/**
 * Flag "nouveau coach" pour un match : vrai si DOMICILE ou EXTERIEUR a un
 * coach nomme depuis moins de windowDays jours.
 * Best-effort : jamais d'exception (try/catch interne), false par defaut.
 */
function coachNewForMatch(db, homeName, awayName, nowMs, windowDays = NEW_COACH_DAYS_DEFAULT) {
  try {
    for (const [side, name] of [['home', homeName], ['away', awayName]]) {
      const slug = slugForTeamName(name)
      if (!slug) continue
      const info = getCoachInfo(db, slug, nowMs, windowDays)
      if (info.isNew) return { isNew: true, side, ...info }
    }
  } catch (_) {}
  return { isNew: false, side: null, manager: null, appointed: null, daysSince: null }
}

module.exports = { getCoachInfo, isNewCoach, daysSince, slugForTeamName, normalizeName, coachNewForMatch, NEW_COACH_DAYS_DEFAULT }
