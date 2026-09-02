/**
 * UnderPatternEngine.js — Détecteur de patterns sous-factoriels
 *
 * Détecte les matchs où le terrain, l'arbitrage, le contexte ou le style
 * de jeu favorisent le UNDER (peu de buts). Ajuste la probabilité O/U
 * en conséquence.
 *
 * Patterns détectés :
 *   1. League Under Rate — ligues historiquement sous (ex. Persian Gulf 23% 0-0)
 *   2. Team Defensive Profile — équipes qui marquent peu / encaissent peu
 *   3. Derby / Match Tendu — derbies = faible scoring (0-0, 1-0)
 *   4. Low Expected Score — xG combiné < 2.5
 *   5. Odds Market Signal — cotes under < over = marché dit "under"
 *
 * Pipeline :
 *   match → detectPatterns(match) → { patterns[], adjustment, adjustedProb }
 *
 * Usage dans topPicksEngine / accuracyEngine pour corriger ou_25_prob
 * avant calcul EV / pick.
 */

const logger = require('../core/logger')

// ── Constantes ───────────────────────────────────────────────────
const MIN_LEAGUE_MATCHES = 10
const UNDER_RATE_THRESHOLD = 55 // ligue "sous" si > 55% de matchs < 2.5 buts
const LOW_XG_THRESHOLD = 2.2 // xG combiné faible
const DERBY_KEYWORDS = /derby|clásico|classeico|rival|local|régional/i

// Poids de chaque pattern dans l'ajustement final (total = 100)
const WEIGHTS = {
  leagueUnder: 25,
  teamDefensive: 25,
  derby: 15,
  lowXg: 20,
  oddsSignal: 15,
}

let _db = null
function getDb(injected) {
  if (injected) return injected
  if (_db) return _db
  _db = require('../core/database').db
  return _db
}

// ── Cache ligue (rebuild toutes les 6h) ─────────────────────────
let _leagueCache = null
let _leagueCacheAt = 0
const LEAGUE_TTL = 6 * 3600 * 1000

function getLeagueStats(db) {
  const now = Date.now()
  if (_leagueCache && now - _leagueCacheAt < LEAGUE_TTL) return _leagueCache
  try {
    const rows = db.prepare(`
      SELECT league,
        COUNT(*) as n,
        AVG(scoreHome + scoreAway) as avgGoals,
        SUM(CASE WHEN scoreHome + scoreAway < 2.5 THEN 1 ELSE 0 END) as underCount,
        SUM(CASE WHEN scoreHome + scoreAway = 0 THEN 1 ELSE 0 END) as zeroZero,
        AVG(scoreHome) as avgHome,
        AVG(scoreAway) as avgAway
      FROM historical_matches
      WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
      GROUP BY league
      HAVING n >= ?
    `).all(MIN_LEAGUE_MATCHES)
    const map = {}
    for (const r of rows) {
      map[r.league] = {
        n: r.n,
        avgGoals: r.avgGoals,
        underRate: r.underCount / r.n,
        zeroZeroRate: r.zeroZero / r.n,
        avgHome: r.avgHome,
        avgAway: r.avgAway,
      }
    }
    _leagueCache = map
    _leagueCacheAt = now
    logger.debug(`[UNDER-PATTERN] Cache ligue: ${rows.length} ligues chargées`)
  } catch (e) {
    logger.warn(`[UNDER-PATTERN] Cache ligue échoué: ${e.message}`)
    _leagueCache = {}
  }
  return _leagueCache
}

// ── Cache équipe (rebuild toutes les 12h) ───────────────────────
let _teamCache = null
let _teamCacheAt = 0
const TEAM_TTL = 12 * 3600 * 1000

function getTeamStats(db) {
  const now = Date.now()
  if (_teamCache && now - _teamCacheAt < TEAM_TTL) return _teamCache
  try {
    // Stats en tant que home + away combinées
    const home = db.prepare(`
      SELECT homeTeam as team,
        COUNT(*) as n,
        AVG(scoreHome) as avgScored,
        AVG(scoreAway) as avgConceded,
        AVG(scoreHome + scoreAway) as totalGoals,
        SUM(CASE WHEN scoreHome + scoreAway < 2.5 THEN 1 ELSE 0 END) as underCount
      FROM historical_matches
      WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
      GROUP BY homeTeam
      HAVING n >= 5
    `).all()
    const away = db.prepare(`
      SELECT awayTeam as team,
        COUNT(*) as n,
        AVG(scoreAway) as avgScored,
        AVG(scoreHome) as avgConceded,
        AVG(scoreHome + scoreAway) as totalGoals,
        SUM(CASE WHEN scoreHome + scoreAway < 2.5 THEN 1 ELSE 0 END) as underCount
      FROM historical_matches
      WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
      GROUP BY awayTeam
      HAVING n >= 5
    `).all()
    const map = {}
    for (const r of [...home, ...away]) {
      if (!map[r.team]) map[r.team] = { n: 0, underCount: 0, totalGoals: 0 }
      map[r.team].n += r.n
      map[r.team].underCount += r.underCount
      map[r.team].totalGoals += r.totalGoals * r.n
    }
    for (const t of Object.values(map)) {
      t.avgGoals = t.totalGoals / t.n
      t.underRate = t.underCount / t.n
    }
    _teamCache = map
    _teamCacheAt = now
    logger.debug(`[UNDER-PATTERN] Cache équipe: ${Object.keys(map).length} équipes`)
  } catch (e) {
    logger.warn(`[UNDER-PATTERN] Cache équipe échoué: ${e.message}`)
    _teamCache = {}
  }
  return _teamCache
}

// ── Pattern 1 : League Under Rate ────────────────────────────────
function detectLeagueUnder(match, leagueStats) {
  const league = match.league || match.tournament_name || ''
  const stats = leagueStats[league]
  if (!stats || stats.n < MIN_LEAGUE_MATCHES) return null
  const underRate = stats.underRate * 100
  if (underRate < UNDER_RATE_THRESHOLD) return null
  return {
    type: 'league_under',
    label: `${league}: ${underRate.toFixed(0)}% under (n=${stats.n})`,
    strength: Math.min((underRate - UNDER_RATE_THRESHOLD) / 20, 1),
    adjDirection: -1,
    weight: WEIGHTS.leagueUnder,
  }
}

// ── Pattern 2 : Team Defensive Profile ───────────────────────────
function detectTeamDefensive(match, teamStats) {
  const home = teamStats[match.homeTeam]
  const away = teamStats[match.awayTeam]
  const factors = []
  if (home && home.n >= 5 && home.avgGoals < 2.2) {
    factors.push({ team: match.homeTeam, avg: home.avgGoals, n: home.n })
  }
  if (away && away.n >= 5 && away.avgGoals < 2.2) {
    factors.push({ team: match.awayTeam, avg: away.avgGoals, n: away.n })
  }
  if (factors.length === 0) return null
  const avgGoals = factors.reduce((s, f) => s + f.avg, 0) / factors.length
  const strength = Math.min((2.2 - avgGoals) / 1.0, 1)
  return {
    type: 'team_defensive',
    label: `Équipes défensives: ${factors.map(f => `${f.team} (${f.avg.toFixed(1)} buts/m)`).join(', ')}`,
    strength,
    adjDirection: -1,
    weight: WEIGHTS.teamDefensive,
  }
}

// ── Pattern 3 : Derby / Match Tendu ──────────────────────────────
function detectDerby(match) {
  const league = match.league || ''
  const home = match.homeTeam || ''
  const away = match.awayTeam || ''
  const text = `${home} ${away} ${league}`
  if (!DERBY_KEYWORDS.test(text)) return null
  return {
    type: 'derby',
    label: `Derby/rival: ${home} vs ${away}`,
    strength: 0.6,
    adjDirection: -1,
    weight: WEIGHTS.derby,
  }
}

// ── Pattern 4 : Low Expected Score ───────────────────────────────
function detectLowXg(match) {
  const xgH = parseFloat(match.home_xg) || parseFloat(match.expected_score_home) || 0
  const xgA = parseFloat(match.away_xg) || parseFloat(match.expected_score_away) || 0
  const totalXg = xgH + xgA
  if (totalXg <= 0 || totalXg >= LOW_XG_THRESHOLD) return null
  const strength = Math.min((LOW_XG_THRESHOLD - totalXg) / 1.0, 1)
  return {
    type: 'low_xg',
    label: `xG faible: ${totalXg.toFixed(2)} (${xgH.toFixed(2)} + ${xgA.toFixed(2)})`,
    strength,
    adjDirection: -1,
    weight: WEIGHTS.lowXg,
  }
}

// ── Pattern 5 : Odds Market Signal ───────────────────────────────
function detectOddsSignal(match) {
  const ouOver = parseFloat(match.odds_over25) || 0
  const ouUnder = parseFloat(match.odds_under25) || 0
  if (ouOver <= 1 || ouUnder <= 1) return null
  // Si under est favori (cote under < cote over), le marché dit "under"
  if (ouUnder >= ouOver) return null
  const diff = ouOver - ouUnder
  const strength = Math.min(diff / 1.5, 1)
  return {
    type: 'odds_signal',
    label: `Cotes Under favori: ${ouUnder.toFixed(2)} < ${ouOver.toFixed(2)}`,
    strength,
    adjDirection: -1,
    weight: WEIGHTS.oddsSignal,
  }
}

// ── Fonction principale ──────────────────────────────────────────
/**
 * Détecte les patterns sous-factoriels pour un match et retourne
 * l'ajustement à appliquer sur la probabilité O/U.
 *
 * @param {object} match — objet match (avec league, homeTeam, awayTeam, etc.)
 * @param {object} options — { db, ou25Prob } (probabilité O/U initiale)
 * @returns {{ patterns: Array, adjustment: number, adjustedProb: number, signal: string }}
 */
function detectPatterns(match, options = {}) {
  const db = getDb(options.db)
  const leagueStats = getLeagueStats(db)
  const teamStats = getTeamStats(db)
  const patterns = [
    detectLeagueUnder(match, leagueStats),
    detectTeamDefensive(match, teamStats),
    detectDerby(match),
    detectLowXg(match),
    detectOddsSignal(match),
  ].filter(Boolean)
  if (patterns.length === 0) {
    return { patterns: [], adjustment: 0, adjustedProb: options.ou25Prob || 50, signal: 'none' }
  }
  // Score pondéré : moyenne des forces × poids
  let weightedSum = 0
  let weightTotal = 0
  for (const p of patterns) {
    weightedSum += p.strength * p.weight
    weightTotal += p.weight
  }
  const avgStrength = weightTotal > 0 ? weightedSum / weightTotal : 0
  // Ajustement max = -20 points de probabilité (ne jamais inverser complètement)
  const maxAdj = -20
  const adjustment = Math.max(maxAdj, Math.round(avgStrength * maxAdj))
  const baseProb = options.ou25Prob != null ? options.ou25Prob : 50
  const adjustedProb = Math.max(10, Math.min(90, baseProb + adjustment))
  return {
    patterns,
    adjustment,
    adjustedProb,
    signal: patterns.map(p => p.type).join('+'),
  }
}

module.exports = { detectPatterns, getLeagueStats, getTeamStats, _internal: { WEIGHTS, UNDER_RATE_THRESHOLD, LOW_XG_THRESHOLD } }
