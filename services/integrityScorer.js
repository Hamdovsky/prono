/**
 * integrityScorer.js — E70 Post-Match Integrity Scorer
 * ─────────────────────────────────────────────────────
 * Calcule un score d'intégrité "a posteriori" sur les matchs terminés.
 * Objectif : flaguer les matchs STATISTIQUEMENT ANORMAUX, pas d'accuser
 * quiconque de match-fixing. Le verdict reste probabiliste.
 *
 * 8 signaux :
 *   1a. XG_DECEPTION        → le gagnant a un xG très inférieur à ses buts réels
 *   1b. XG_BETRAYAL         → le perdant avait un xG ≥ 1.5x celui du vainqueur (signature n°1)
 *   2.  LONGSHOT_WINNER     → le gagnant était à plus de 5.0 de cote MARCHÉ (implied < 20%)
 *   3.  STEAM_VINDICATED    → la cote du gagnant a chuté > 25% entre ouverture et clôture
 *   4.  ANOMALOUS_INCIDENT  → but ≤5', penalty décisif, rouge <20', but contre son camp
 *   5.  DEAD_ZONE_CONTEXT   → match sans enjeu (zone morte / titre assuré / relégation)
 *   6.  FAVORITE_COLLAPSE   → favori (cote ≤1.8) battu de 3+ buts SANS domination xG
 *   7.  COMPLAISANCE        → signature d'historique suspect stockée
 *
 * Verdicts : NORMAL < 25 ≤ A_SURVEILLER < 50 ≤ SUSPECT < 75 ≤ HAUTEMENT_SUSPECT
 * Si aucune famille de données n'est exploitable → DONNEE_INSUFFISANTE (pas NORMAL).
 *
 * ⚠️ LIMITES MESURÉES (E70, sur 14 000 matchs en base) :
 *   - couverture xG : 2 987/12 563 sur historical_matches, 0/1 463 sur matches
 *   - incidents stockés : 0 · motivation_signature : 0
 *   → les signaux 4/5/7 ne peuvent PAS se déclencher aujourd'hui.
 *     Le détecteur ne sera pleinement opérationnel qu'après le correctif du pipeline
 *     (cf. CHANGELOG_AUDIT.md E70).
 */

const logger = require('../core/logger')

const CAP = 100

const VERDICTS = [
  [75, 'HAUTEMENT_SUSPECT'],
  [50, 'SUSPECT'],
  [25, 'A_SURVEILLER'],
  [0, 'NORMAL'],
]

/** Verdict utilisé quand aucune donnée exploitable n'est disponible (E70). */
const VERDICT_NO_DATA = 'DONNEE_INSUFFISANTE'

const OWN_GOAL_KW = ['own goal', 'own-goal', 'but contre son camp', 'goal in own', 'هدف ذاتي']
const COMPLAISANCE_KW = ['COMPLAISANCE']

/**
 * Sources de cotes à REJETER pour tout signal de marché (E59).
 * `fair_odds_model` / `synthetic` / `model_league` sortent de NOTRE propre modèle :
 * les utiliser pour juger « le marché voyait cette équipe perdante » serait un
 * raisonnement circulaire (on se compare à soi-même).
 */
const ODDS_SOURCES_REJECT = ['SYNTHETIC', 'FAIR_ODDS_MODEL', 'MODEL_LEAGUE', 'UNKNOWN', '']
const DEAD_ZONE_KW = [
  'ZONE_MORTE',
  'ZONE MORTE',
  'CHAMPION_ASSURE',
  'CHAMPION',
  'RELEGUE_ASSURE',
  'RELEGUE',
]

function _clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function _fullData(match) {
  if (!match) return {}
  const raw = match.fullData
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch (e) {
      return {}
    }
  }
  return raw
}

/**
 * Normalise un objet match (ligne DB ou objet léger) vers une forme canonique.
 */
function _normalize(match) {
  const fd = _fullData(match)
  const pick = (...vals) => {
    for (const v of vals) {
      const n = _num(v)
      if (n !== null) return n
    }
    return null
  }

  return {
    scoreH: pick(match.scoreHome, match.score_home, fd.scoreHome),
    scoreA: pick(match.scoreAway, match.score_away, fd.scoreAway),
    // xG aberrant => neutralisé (cf. _isPlausibleXg)
    xgH: _plausibleOrNull(pick(match.home_xg, match.xg_home, fd.home_xg, fd.xg_home)),
    xgA: _plausibleOrNull(pick(match.away_xg, match.xg_away, fd.away_xg, fd.xg_away)),
    league: match.league || match.competition || fd.league || '',
    oddsH: pick(match.odds_home, fd.odds_home, fd.odds?.home),
    oddsA: pick(match.odds_away, fd.odds_away, fd.odds?.away),
    openH: pick(match.odds_home_open, fd.odds_home_open, fd.odds?.opening?.home),
    openA: pick(match.odds_away_open, fd.odds_away_open, fd.odds?.opening?.away),
    probH: pick(match.true_prob_home, match.home_win_probability, fd.true_prob_home),
    probA: pick(match.true_prob_away, match.away_win_probability, fd.true_prob_away),
    oddsSource: String(match.odds_source ?? fd.odds_source ?? '').toUpperCase(),
    signature: String(match.motivation_signature || fd.motivation_signature || '').toUpperCase(),
  }
}

function _plausibleOrNull(v) {
  return _isPlausibleXg(v) ? v : null
}

/**
 * Un xG de match doit être plausible : 0 à 12.
 * E70 : la base contient des xG corrompus (1 609 873.45, 141 905 054.19, 19.25)
 * qui produisaient des ratios de 5 366 244x. On préfère NE RIEN MESURER plutôt
 * que mesurer une valeur aberrante.
 */
const XG_MIN = 0
const XG_MAX = 12

function _isPlausibleXg(v) {
  return v != null && v >= XG_MIN && v <= XG_MAX
}

/**
 * Les cotes de ce match sont-elles issues d'une source de marché réelle ?
 * (rejette nos propres estimations modèle — cf. ODDS_SOURCES_REJECT)
 */
function _hasRealOdds(m) {
  if (!ODDS_SOURCES_REJECT.includes(m.oddsSource)) return true
  // Source non renseignée : on n'accorde pas le bénéfice du doute sur un signal de marché.
  return false
}

/**
 * Coupes et Seafood : l'effectif est rotatif, un scoreylateur n'y dit rien.
 * On ne retire PAS le match, on marque le verdict comme peu fiable.
 */
const CUP_KW = /\b(cup|copa|coppa|pokal|emcup|qualification|qualif|nem\b|nm cup|em\b|playoff|uefa|europa|conference|champions|troph|fd\bpok)/i

function _isRotationProne(league) {
  return CUP_KW.test(String(league || ''))
}

function _verdict(score) {
  const s = _clamp(_num(score) ?? 0, 0, CAP)
  for (const [threshold, label] of VERDICTS) {
    if (s >= threshold) return label
  }
  return 'NORMAL'
}

/**
 * Signal 1a : sur-rendement du gagnant (xG très inférieur à ses buts).
 * z = (buts − xG) / √(xG + 0.1). Seuil 2.0 (calibré E70 : sur 109 matchs avec xG,
 * le z max observé du gagnant est 3.07 et le min −1.12 — un seuil à −2.5 ne
 * se déclenchait JAMAIS, cf. diagnostic diag2).
 */
function _signalXgDeception(m) {
  if (m.xgH == null || m.xgA == null || m.scoreH == null || m.scoreA == null) return null
  if (m.scoreH === m.scoreA) return null

  const winnerIsHome = m.scoreH > m.scoreA
  const xg = winnerIsHome ? m.xgH : m.xgA
  const goals = winnerIsHome ? m.scoreH : m.scoreA
  if (xg < 0) return null

  const z = (goals - xg) / Math.sqrt(xg + 0.1)
  if (z < 2.0) return null

  const weight = _clamp(Math.round((z - 2.0) * 12) + 12, 12, 25)
  return {
    flag: 'XG_DECEPTION',
    weight,
    detail: `Gagnant avec xG ${xg.toFixed(2)} pour ${goals} buts (z=${z.toFixed(2)}) : sur-rendement très au-dessus de la production attendue.`,
  }
}

/**
 * Signal 1b : trahison xG — l'équipe DOMINÉE perd malgré un xG très supérieur.
 * Signature la plusclassique d'un match arrangé (poids 25). Calibré E70 :
 * ratio xG perdant/vainqueur >= 1.5 avec marge >= 2 buts.
 */
function _signalXgBetrayal(m) {
  if (m.xgH == null || m.xgA == null || m.scoreH == null || m.scoreA == null) return null
  if (m.scoreH === m.scoreA) return null

  const margin = Math.abs(m.scoreH - m.scoreA)
  if (margin < 2) return null

  const homeWon = m.scoreH > m.scoreA
  const winnerXg = homeWon ? m.xgH : m.xgA
  const loserXg = homeWon ? m.xgA : m.xgH
  if (winnerXg < 0) return null

  const ratio = loserXg / Math.max(0.05, winnerXg)
  if (ratio < 1.5 || loserXg < 1.2) return null

  return {
    flag: 'XG_BETRAYAL',
    weight: 25,
    detail: `L'équipe perdante avait un xG de ${loserXg.toFixed(2)} contre ${winnerXg.toFixed(2)} (ratio ${ratio.toFixed(1)}x) et a pourtant perdu de ${margin} buts : domination stat traitor.`,
  }
}

/**
 * Signal 2 : le gagnant était outsider lointain (cote > 5.0 sur source RÉELLE).
 * Les cotes issues de notre propre modèle sont ignorées (raisonnement circulaire).
 */
function _signalLongshotWinner(m) {
  if (m.scoreH == null || m.scoreA == null || m.scoreH === m.scoreA) return null
  if (!_hasRealOdds(m)) return null

  const odds = m.scoreH > m.scoreA ? m.oddsH : m.oddsA
  if (odds == null || odds <= 5.0) return null

  return {
    flag: 'LONGSHOT_WINNER',
    weight: 25,
    detail: `Vainqueur à la cote ${odds.toFixed(2)} sur le marché réel (probabilité implicite ${((1 / odds) * 100).toFixed(0)}%).`,
  }
}

/**
 * Signal 3 : steam vindiqué — la cote du gagnant a chuté fortement entre
 * l'ouverture et la clôture (quelqu'un « savait »). Sources réelles uniquement.
 */
function _signalSteamVindicated(m) {
  if (m.scoreH == null || m.scoreA == null || m.scoreH === m.scoreA) return null
  if (!_hasRealOdds(m)) return null

  const winnerIsHome = m.scoreH > m.scoreA
  const open = winnerIsHome ? m.openH : m.openA
  const close = winnerIsHome ? m.oddsH : m.oddsA
  if (open == null || close == null || open <= 0) return null

  const drop = (open - close) / open
  if (drop <= 0.25) return null

  return {
    flag: 'STEAM_VINDICATED',
    weight: 20,
    detail: `Cote du vainqueur de ${open.toFixed(2)} à ${close.toFixed(2)} (−${Math.round(drop * 100)}%) avant le coup d'envoi.`,
  }
}

/**
 * Signal 4 : incidents de match anormaux (but ≤5', penalty décisif,
 * rouge <20', but contre son camp). 2 signaux maximum, 15 pts chacun.
 */
function _signalAnomalousIncidents(m, incidents) {
  if (!Array.isArray(incidents) || incidents.length === 0) return null

  const found = []
  const has = (flag) => found.some((f) => f.flag === flag)

  for (const inc of incidents) {
    if (!inc || typeof inc !== 'object') continue
    const t = parseInt(inc.time, 10) || 0
    const type = String(inc.type || inc.incidentType || inc.incidentClass || '').toLowerCase()
    const text = String(inc.text || '').toLowerCase()

    const isGoal = type === 'goal' || inc.incidentClass === 'regular' || inc.incidentClass === 'penalty'
    if (isGoal && t <= 5 && !has('EARLY_GOAL')) {
      found.push({ flag: 'EARLY_GOAL', detail: `But dès la ${t}' — rythme anormal.` })
    }
    if ((type.includes('own') || OWN_GOAL_KW.some((kw) => text.includes(kw))) && !has('OWN_GOAL')) {
      found.push({ flag: 'OWN_GOAL', detail: 'But contre son camp — signature récurrente.' })
    }
  }

  const earlyRed = incidents.find((inc) => {
    if (!inc || typeof inc !== 'object') return false
    const t = parseInt(inc.time, 10) || 0
    const type = String(inc.type || inc.incidentType || inc.incidentClass || '').toLowerCase()
    const text = String(inc.text || '').toLowerCase()
    return t < 20 && (type.includes('red') || text.includes('red card'))
  })
  if (earlyRed) {
    found.push({ flag: 'EARLY_RED', detail: 'Carton rouge avant la 20e minute — déroulé altéré.' })
  }

  const margin = Math.abs((m.scoreH ?? 0) - (m.scoreA ?? 0))
  const hasPenalty = incidents.some((inc) => {
    if (!inc || typeof inc !== 'object') return false
    return inc.incidentClass === 'penalty' || String(inc.text || '').toLowerCase().includes('penalty')
  })
  if (hasPenalty && margin === 1) {
    found.push({ flag: 'DECISIVE_PENALTY', detail: "Penalty décisif sur un match à l'écart d'un but." })
  }

  if (found.length === 0) return null

  const kept = found.slice(0, 2)
  return {
    flag: 'ANOMALOUS_INCIDENT',
    weight: kept.length * 15,
    detail: kept.map((k) => `${k.flag} — ${k.detail}`).join(' | '),
    subFlags: kept.map((k) => k.flag),
  }
}

/**
 * Signal 5 : contexte de match sans enjeu.
 */
function _signalDeadZone(m) {
  if (!m.signature) return null
  const hit = DEAD_ZONE_KW.find((kw) => m.signature.includes(kw))
  if (!hit) return null
  return {
    flag: 'DEAD_ZONE_CONTEXT',
    weight: 10,
    detail: `Match sans enjeu sportif (${hit}) : contexte favorable aux arrangements.`,
  }
}

/**
 * Signal 6 : effondrement du favori (cote réelle <= 1.8) battu de 3+ buts
 * SANS domination xG totale — volontairement DISJOINT de XG_BETRAYAL (ratio < 1.5)
 * pour éviter de compter deux fois le même match.
 */
function _signalFavoriteCollapse(m) {
  if (m.scoreH == null || m.scoreA == null || m.xgH == null || m.xgA == null) return null
  if (!_hasRealOdds(m)) return null

  const margin = Math.abs(m.scoreH - m.scoreA)
  if (margin < 3) return null

  const homeIsFav = m.oddsH != null && m.oddsH <= 1.8
  const awayIsFav = m.oddsA != null && m.oddsA <= 1.8
  if (homeIsFav === awayIsFav) return null

  const favIsHome = homeIsFav
  const winnerXg = favIsHome ? m.xgA : m.xgH
  const loserXg = favIsHome ? m.xgH : m.xgA
  const ratio = loserXg / Math.max(0.05, winnerXg)
  if (ratio >= 1.5) return null

  return {
    flag: 'FAVORITE_COLLAPSE',
    weight: 20,
    detail: `Favori du marché (${favIsHome ? 'domicile' : 'extérieur'}, cote <= 1.8) battu de ${margin} buts alors que son xG était ${loserXg.toFixed(2)} contre ${winnerXg.toFixed(2)}.`,
  }
}

/**
 * Signal 7 : signature COMPLAISANCE stockée (historique déjà signalé).
 */
function _signalComplaisance(m) {
  if (!m.signature) return null
  if (!COMPLAISANCE_KW.some((kw) => m.signature.includes(kw))) return null
  return {
    flag: 'COMPLAISANCE',
    weight: 30,
    detail: "Signature COMPLAISANCE : historique de l'équipe déjà signalé pour performances suspectes.",
  }
}

/**
 * Détermine quelles FAMILLES de signaux sont réellement évaluables sur ce match.
 * Sans cela on confond « aucune anomalie détectée » et « aucune donnée pour détecter »
 * (erreur constatée E70 : 2970/3000 matchs classés NORMAL alors que la couverture
 * xG est de 3% et qu'aucun incident n'est stocké).
 */
function _coverage(m, incidents) {
  const families = []
  if (m.xgH != null && m.xgA != null) families.push('XG')
  if (m.oddsH != null && m.oddsA != null && _hasRealOdds(m)) families.push('MARCHE')
  if (Array.isArray(incidents) && incidents.length > 0) families.push('INCIDENTS')
  if (m.signature) families.push('SIGNATURE')
  return families
}

/**
 * Point d'entrée : score un match terminé.
 * @param {object} match - ligne matches/historical_matches (fullData string ou objet)
 * @returns {{fixing_score:number, flags:string[], signals:object[], verdict:string,
 *            coverage:string[], assessable:boolean, note:string}}
 */
function scoreMatch(match) {
  try {
    const m = _normalize(match)
    const fd = _fullData(match)
    const incidents = Array.isArray(match.incidents) ? match.incidents : fd.incidents || []

    const signals = [
      _signalXgDeception(m),
      _signalXgBetrayal(m),
      _signalLongshotWinner(m),
      _signalSteamVindicated(m),
      _signalAnomalousIncidents(m, incidents),
      _signalDeadZone(m),
      _signalFavoriteCollapse(m),
      _signalComplaisance(m),
    ].filter(Boolean)

    const score = _clamp(
      signals.reduce((acc, s) => acc + s.weight, 0),
      0,
      CAP
    )
    const flags = [...new Set(signals.flatMap((s) => [s.flag, ...(s.subFlags || [])]))]
    const coverage = _coverage(m, incidents)
    const assessable = coverage.length > 0

    // E70 : un score élevé sur un match à effectif rotatif ou au score extrême
    // s'explique souvent par la composition / un carton rouge. On NE SUPRIME PAS
    // le signal, on marque explicitement que le verdict n'est pas fiable.
    const margin = m.scoreH != null && m.scoreA != null ? Math.abs(m.scoreH - m.scoreA) : 0
    const rotationProne = _isRotationProne(m.league)
    const chaoticScore = margin >= 5
    const lowConfidence = score >= 25 && (rotationProne || chaoticScore)
    if (lowConfidence) flags.push('CONFIANCE_FAIBLE')

    // Un score élevé mais explicable (rotation d'effectif, expulsion, score extrême)
    // ne doit JAMAIS remonter au verdict SUSPECT : on plafonne à A_SURVEILLER.
    // E70 : sans ce plafond, 34 des 36 « SUSPECT » initiaux étaient des coupes
    // à 4-9 buts — un taux de faux positifs inacceptable.
    const verdict = !assessable ? VERDICT_NO_DATA : lowConfidence ? 'A_SURVEILLER' : _verdict(score)

    const baseNote = assessable
      ? "ANOMALIE statistique, pas preuve de match-fixing. À recouper avec le contexte (blessures, mercato, météo)."
      : "Aucune donnée exploitable (xG / cotes marché / incidents / signature) : match NON ÉVALUABLE, pas 'normal'."

    return {
      fixing_score: score,
      flags,
      signals: signals.map((s) => ({ flag: s.flag, weight: s.weight, detail: s.detail })),
      coverage,
      assessable,
      low_confidence: lowConfidence,
      verdict,
      note: lowConfidence
        ? `${baseNote} ATTENTION : ${rotationProne ? 'compétition à effectif rotatif' : 'score extrême'} — score peu fiable.`
        : baseNote,
    }
  } catch (e) {
    logger.error(`[INTEGRITY] scoreMatch failed for ${match?.id}: ${e.message}`)
    return {
      fixing_score: 0,
      flags: [],
      signals: [],
      coverage: [],
      assessable: false,
      verdict: VERDICT_NO_DATA,
      note: 'Erreur de scoring.',
    }
  }
}

module.exports = { scoreMatch, _verdict, VERDICT_NO_DATA }
