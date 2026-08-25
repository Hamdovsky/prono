/**
 * proPlanEngine.js — Moteur "Plan Pro 1X2" (100 DT → 400 DT).
 *
 * Discipline stricte, isolée du mix de marchés :
 *   - Uniquement le marché 1X2 (O/U 2.5 et BTTS restent disponibles séparément) ;
 *   - Ligues autorisées : top-5 + ligues "fiables" (league_weights avec une
 *     exactitude historique >= MIN_LEAGUE_ACCURACY et >= MIN_LEAGUE_SAMPLES cas) ;
 *   - Règle du nul (X) : pick "X" accepté seulement si proba calibrée >= 45 %
 *     ET cote >= 3.0 (le nul est l'avantage du bookmaker) ;
 *   - Les filtres STRICTS de topPicksEngine restent appliqués (edge >= 5 %,
 *     EV >= 5 %, proba calibrée 55-75 %, guards Confluence/Overconfident).
 *
 * Le bankroll et les mises sont gérés par services/proPlanBankroll.js.
 */

const topPicksEngine = require('./topPicksEngine')
const logger = require('../core/logger')

// ── Constantes de discipline ─────────────────────────────────────
const TOP5_LEAGUES = ['premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1']
const MIN_LEAGUE_ACCURACY = 0.58
const MIN_LEAGUE_SAMPLES = 50
const MIN_DRAW_PROB = 45
const MIN_DRAW_ODDS = 3.0
const DEFAULT_LIMIT = 5

// ── Ligues fiables (dérivées de l'historique league_weights) ─────
function getReliableLeagues() {
  const set = new Set()
  try {
    const db = require('../core/database').db
    if (!db) return set
    const rows = db.prepare('SELECT league, accuracy, total_cases FROM league_weights').all()
    for (const r of rows) {
      const acc = Number(r.accuracy) || 0
      const cases = Number(r.total_cases) || 0
      if (acc >= MIN_LEAGUE_ACCURACY && cases >= MIN_LEAGUE_SAMPLES) {
        set.add(String(r.league).toLowerCase().trim())
      }
    }
  } catch (e) {
    logger.warn(`[PRO-PLAN] league_weights indisponible: ${e.message}`)
  }
  return set
}

function leagueAllowed(leagueName, reliableSet) {
  const name = String(leagueName || '').toLowerCase().trim()
  if (!name) return false
  if (TOP5_LEAGUES.some((t) => name.includes(t))) return true
  if (reliableSet.has(name)) return true
  for (const r of reliableSet) {
    if (r.includes(name) || name.includes(r)) return true
  }
  return false
}

function isDrawAllowed(pick, modelProbability, odds) {
  if (pick !== 'X') return true
  const prob = Number(modelProbability) || 0
  const o = Number(odds) || 0
  return prob >= MIN_DRAW_PROB && o >= MIN_DRAW_ODDS
}

/**
 * Sélection strictement 1X2 du jour, avec discipline ligues + règle du nul.
 * @param {object} opts { limit = 5, days = 14 }
 * @returns {Promise<{picks, generatedAt, analyzed, rejected, filters}>}
 */
async function selectProPicks1X2({ limit = DEFAULT_LIMIT, days = 14 } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), 10)
  const reliable = getReliableLeagues()

  const result = await topPicksEngine.selectTopPicksOfDay({
    limit: 10, // batch plus large, filtré ensuite par la discipline du plan
    days,
    markets: ['1X2'],
  })

  const picks = result.picks
    .filter((p) => p.marketType === '1X2')
    .filter((p) => leagueAllowed(p.leagueName, reliable))
    .filter((p) => isDrawAllowed(p.recommendedPick, p.modelProbability, p.odds))
    .slice(0, cappedLimit)

  return {
    picks,
    generatedAt: result.generatedAt,
    analyzed: result.analyzed,
    rejected: result.rejected,
    filters: {
      edgePct: result.filters.edgePct,
      ev: result.filters.ev,
      probMin: result.filters.probMin,
      probMax: result.filters.probMax,
      leagues: 'top-5 + fiables (acc>=58%, samples>=50)',
      drawRule: 'X si proba>=45% ET cote>=3.0',
      reliableLeagues: reliable.size,
    },
  }
}

module.exports = {
  selectProPicks1X2,
  getReliableLeagues,
  leagueAllowed,
  isDrawAllowed,
  _internal: {
    TOP5_LEAGUES,
    MIN_LEAGUE_ACCURACY,
    MIN_LEAGUE_SAMPLES,
    MIN_DRAW_PROB,
    MIN_DRAW_ODDS,
  },
}
