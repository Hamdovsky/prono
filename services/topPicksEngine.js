/**
 * topPicksEngine.js — Moteur de sélection "Top Picks du Jour" (STRICT).
 *
 * Pipeline :
 *  1. Charge les matchs programmés / à venir (fenêtre : -12h → +N jours).
 *  2. Pour chaque match : construit des candidats de marché
 *     (1X2 via ValueBetEngine + recalibrage empirique services/calibrator.js,
 *     Over 2.5, BTTS quand cotes réelles dispo).
 *  3. Filtres STRICTS pour devenir un Top Pick :
 *       Edge   >= +5 pts (vs proba marché de-vigée)
 *       EV     >= +5 %   (rendement espéré)
 *       Proba calibrée  : 55 % ≤ p ≤ 75 %
 *       Guards sécurité : pas de veto Confluence Guard,
 *                         No-Bet Overconfident (p ≤ 78 %, écart modèle/marché
 *                         ≤ 25 pts, Kelly positif, cotes réelles présentes).
 *  4. Score qualité (Confluence ajusté / stabilité / edge / EV) → classement.
 *  5. Top 3-5 uniquement (limit par défaut = 5).
 *
 * selectStablePicks — plan "Stables" : Double Chance à proba calibrée et
 * EV réel positif (cotes réelles exigées, pas de DC annoncée ≥ 80 %).
 *
 * Chaque pick expose le payload JSON documenté :
 *   matchId, homeTeam, awayTeam, leagueName, matchTime, marketType,
 *   recommendedPick, odds, modelProbability, edgePct, stakeRecommendation,
 *   reasoningSummary.
 */

const ValueBetEngine = require('../src/services/ValueBetEngine')
const logger = require('../core/logger')
let _calibrator = null
function getCalibrator() {
  if (!_calibrator) {
    try {
      _calibrator = require('./calibrator')
    } catch {
      _calibrator = null
    }
  }
  return _calibrator
}
let _suffSvc = null
function getSuffSvc() {
  if (!_suffSvc) {
    try {
      _suffSvc = require('./dataSufficiencyService')
    } catch {
      _suffSvc = null
    }
  }
  return _suffSvc
}

// ── Seuils STRICTS ──────────────────────────────────────────────
const MIN_EDGE_PCT = 5.0 // Edge >= 5 %
const MIN_EV = 0.05 // EV >= 5 %
const PROB_MIN = 55 // Proba calibrée (bas)
const PROB_MAX = 75 // Proba calibrée (haut)
const OVERCONFIDENT_PROB = 78 // No-Bet : proba modèle trop haute
const MAX_MODEL_MARKET_GAP = 25 // No-Bet : écart modèle vs marché
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const LOOKBACK_H = 12 // fenêtre passée (matchs du jour déjà commencés)
const RESERVE_RE = /\b(II|III|IV|B|C|U\d{2}|U-\d{2}|Reserves?|Youth|Academy|Reserve|Filial|Amateurs?|Dev(elopment)?|Juniors?)\b/i
// ── Plan "Stables" (Double Chance, probas calibrées) ─────────────
const STABLES_MIN_PROB = 65 // proba calibrée DC
const STABLES_MIN_ODDS = 1.48 // cote combinée réelle
const STABLES_MIN_EV = 0.02 // EV >= +2 %

// ── Petits utilitaires ──────────────────────────────────────────
function round(v, d = 2) {
  if (v == null || isNaN(v)) return 0
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}

function isReserve(name) {
  return name && RESERVE_RE.test(String(name))
}

function fairProb2way(o1, o2) {
  const i1 = o1 && o1 > 1 ? 1 / o1 : 0
  const i2 = o2 && o2 > 1 ? 1 / o2 : 0
  if (i1 + i2 === 0) return null
  return (i1 / (i1 + i2)) * 100
}

// Extraire les cotes RÉELLES uniquement (audit C10).
// Les valeurs de secours codées en dur de QuantumQuantEngine (O2.5=1.85,
// BTTS=1.8/2.05, HT=1.5…) ne sont PAS des cotes marché : les utiliser pour
// l'EV fabrique des "+23%" illusoires (prouvé par les backtests C8/C9 face aux
// vraies cotes archivées). Une cote n'est acceptée que si :
//   - colonne SQLite réelle (odds_over25 / odds_btts_yes / odds_home…), OU
//   - fullData.odds_source renseigné par dataFusion ('betexplorer'|'sofascore'|'footballdata').
function parseFullData(m) {
  try {
    return typeof m.fullData === 'string' ? JSON.parse(m.fullData) : (m.fullData || {})
  } catch {
    return {}
  }
}

function hasRealOddsSource(m) {
  const num = (v) => {
    const f = parseFloat(v)
    return !isNaN(f) && f > 1 ? f : null
  }
  if (num(m.odds_over25) || num(m.odds_under25) || num(m.odds_btts_yes) || num(m.odds_home)) return true
  const fd = parseFullData(m)
  const src = fd.odds_source || (fd.odds && fd.odds.source) || null
  return !!src
}

// Extraire les cotes réelles (colonnes SQLite ou quant.markets).
function getMatchOdds(m) {
  const q = (m.quant && typeof m.quant === 'object') ? m.quant : {}
  const mr = (q.markets && q.markets.match_result) || {}
  const ou = (q.markets && q.markets.over_under) || {}
  const bt = (q.markets && q.markets.btts) || {}
  const num = (v) => {
    const f = parseFloat(v)
    return !isNaN(f) && f > 1 ? f : null
  }
  // Garde C10 : sans source de cotes réelle, les cotes du moteur quant sont des
  // défauts cosmétiques -> ignorées (pas d'EV calculable = pas de pick EV).
  const real = hasRealOddsSource(m)

  const odds = {
    home: num(m.odds_home) || (real ? num(mr['1'] && mr['1'].odds) : null),
    draw: num(m.odds_draw) || (real ? num(mr['X'] && mr['X'].odds) : null),
    away: num(m.odds_away) || (real ? num(mr['2'] && mr['2'].odds) : null),
    over25: num(m.odds_over25) || (real ? num(ou['O2.5'] && ou['O2.5'].odds) : null),
    under25: num(m.odds_under25) || (real ? num(ou['U2.5'] && ou['U2.5'].odds) : null),
    bttsYes: num(m.odds_btts_yes) || (real ? num(bt['YES'] && bt['YES'].odds) : null),
    bttsNo: num(m.odds_btts_no) || (real ? num(bt['NO'] && bt['NO'].odds) : null),
  }
  odds.has1x2 = !!(odds.home && odds.away)
  odds.hasOu = !!(odds.over25 && odds.under25)
  odds.hasBtts = !!(odds.bttsYes && odds.bttsNo)
  return odds
}

// Forme "prediction" attendue par Confluence Guard V2.
function buildPredictionShape(m, pickKey, prob) {
  const verdict = pickKey === 'home' ? 'Home' : pickKey === 'away' ? 'Away' : 'Draw'
  return {
    surgical_confidence: prob,
    confidence: prob,
    home_win_probability: (parseFloat(m.home_win_probability) || 0) / 100,
    draw_probability: (parseFloat(m.draw_probability) || 0) / 100,
    away_win_probability: (parseFloat(m.away_win_probability) || 0) / 100,
    verdict,
    ai_source: m.ai_source || 'TOP_PICKS_ENGINE',
  }
}

// No-Bet Overconfident : exclut les candidats trop sûrs / sans base réelle.
function noBetOverconfident(candidate) {
  const { modelProb, fairProb, odds, kelly, match } = candidate
  if (match && (match.insufficient_data === 1 || match.insufficient_data === '1' || match.sufficient === false)) {
    return { veto: true, reason: 'insufficient_data' }
  }
  if (modelProb > OVERCONFIDENT_PROB) {
    return { veto: true, reason: `overconfident: proba ${round(modelProb)}% > ${OVERCONFIDENT_PROB}%` }
  }
  if (fairProb != null && modelProb - fairProb > MAX_MODEL_MARKET_GAP) {
    return {
      veto: true,
      reason: `overconfident_vs_market: écart ${round(modelProb - fairProb)} pts > ${MAX_MODEL_MARKET_GAP}`,
    }
  }
  if (!odds || odds <= 1) return { veto: true, reason: 'no_real_odds' }
  if (kelly == null || kelly <= 0) return { veto: true, reason: 'no_positive_kelly' }
  return { veto: false, reason: '' }
}

// ── Construction des candidats ───────────────────────────────────
function buildCandidates(m, markets = null) {
  const odds = getMatchOdds(m)
  if (!odds.has1x2 && !odds.hasOu && !odds.hasBtts) return []
  const candidates = []
  const allow = (mt) => !markets || markets.includes(mt)

  let mh = parseFloat(m.home_win_probability) || 0
  let md = parseFloat(m.draw_probability) || 0
  let ma = parseFloat(m.away_win_probability) || 0

  // ── Recalibrage empirique 1X2 (services/calibrator.js) ──
  // Les probabilités brutes sont surconfiantes (~39% réel pour 50-70% annoncé).
  // Les probas calibrées alimentent edge/EV/Kelly et les gardes.
  const cal = getCalibrator()
  if (cal && mh + md + ma > 0) {
    const c = cal.calibrate1x2({ p1: mh || 33, px: md || 33, p2: ma || 33 })
    mh = c.p1
    md = c.px
    ma = c.p2
  }

  // ── 1X2 (via ValueBetEngine : de-vig + edge + EV + Kelly) ──
  if (odds.has1x2 && allow('1X2')) {
    const v = ValueBetEngine.analyzeValue({
      modelHome: mh || 33,
      modelDraw: md || 33,
      modelAway: ma || 33,
      homeOdds: odds.home,
      drawOdds: odds.draw,
      awayOdds: odds.away,
    })
    if (v && v.best) {
      const b = v.best
      const keyMap = { home: '1', draw: 'X', away: '2' }
      candidates.push({
        marketType: '1X2',
        recommendedPick: keyMap[b.selection],
        pickKey: b.selection,
        odds: b.odds,
        modelProb: b.modelProb,
        fairProb: b.fairProb,
        edge: b.edge,
        ev: b.ev,
        kelly: b.kelly,
        match: m,
      })
    }
  }

  // ── Over 2.5 ───────────────────────────────────────────────
  if (odds.hasOu && allow('Over 2.5')) {
    const pOver = parseFloat(m.ou_25_prob)
    if (pOver > 0) {
      const fair = fairProb2way(odds.over25, odds.under25)
      const edge = fair != null ? pOver - fair : null
      const ev = ValueBetEngine.calculateEV(pOver, odds.over25)
      const kelly = ValueBetEngine.kellyStake(pOver, odds.over25)
      if (ev != null && edge != null) {
        candidates.push({
          marketType: 'Over 2.5',
          recommendedPick: 'Over 2.5',
          pickKey: 'over25',
          odds: odds.over25,
          modelProb: pOver,
          fairProb: fair,
          edge,
          ev,
          kelly,
          match: m,
        })
      }
    }
  }

  // ── BTTS ───────────────────────────────────────────────────
  if (odds.hasBtts && allow('BTTS')) {
    const pYes = parseFloat(m.btts_prob)
    if (pYes > 0) {
      const fair = fairProb2way(odds.bttsYes, odds.bttsNo)
      const edge = fair != null ? pYes - fair : null
      const ev = ValueBetEngine.calculateEV(pYes, odds.bttsYes)
      const kelly = ValueBetEngine.kellyStake(pYes, odds.bttsYes)
      if (ev != null && edge != null) {
        candidates.push({
          marketType: 'BTTS',
          recommendedPick: 'Oui',
          pickKey: 'btts',
          odds: odds.bttsYes,
          modelProb: pYes,
          fairProb: fair,
          edge,
          ev,
          kelly,
          match: m,
        })
      }
    }
  }

  return candidates
}

// ── Guards de sécurité ───────────────────────────────────────────
async function runSafetyGuards(m, candidate) {
  let guard
  try {
    guard = require('../core/confluenceGuardV2')
  } catch {
    guard = null
  }
  const predictionShape = buildPredictionShape(m, candidate.pickKey, candidate.modelProb)
  let confluence = null
  if (guard) {
    try {
      confluence = guard.evaluate(m, predictionShape)
    } catch {
      confluence = { veto: false, reason: '', adjustedConfidence: candidate.modelProb, adjustments: [] }
    }
  }
  const overconf = noBetOverconfident(candidate)
  return { confluence, overconf }
}

// ── Score qualité (Confluence / stabilité / edge / EV) ───────────
function computeQualityScore(m, candidate, confluence) {
  const probs = [
    parseFloat(m.home_win_probability) || 0,
    parseFloat(m.draw_probability) || 0,
    parseFloat(m.away_win_probability) || 0,
  ]
    .filter((p) => p > 0)
    .sort((a, b) => b - a)
  const margin = probs.length >= 2 ? probs[0] - probs[1] : 0
  const stability = Math.min(Math.max(margin / 20, 0), 1)
  const adjustedConf = confluence && confluence.adjustedConfidence != null
    ? confluence.adjustedConfidence
    : candidate.modelProb
  const confScore = Math.min(Math.max((adjustedConf - 50) / 25, 0), 1)
  const edgeScore = Math.min(Math.max(candidate.edge / 15, 0), 1)
  const evScore = Math.min(Math.max(candidate.ev / 0.2, 0), 1)
  const qualityScore = round(0.35 * confScore + 0.2 * stability + 0.25 * edgeScore + 0.2 * evScore, 4)
  return { qualityScore, margin, stability, adjustedConf }
}

// ── Reasoning (résumé court : modèle / edge / EV / forme / confluence)
function buildReasoning(m, candidate, extras) {
  const parts = []
  parts.push(`Modèle ${round(candidate.modelProb, 1)}%`)
  parts.push(`Edge +${round(candidate.edge, 1)} pts vs cotes`)
  parts.push(`EV +${round(candidate.ev * 100, 0)}%`)
  if (candidate.kelly > 0) parts.push(`Kelly ${round(candidate.kelly, 1)}%`)

  const isHome = candidate.pickKey === 'home'
  const isAway = candidate.pickKey === 'away'
  const homeForm = parseFloat(m.home_form_pts)
  const awayForm = parseFloat(m.away_form_pts)
  if ((isHome && homeForm > 0) || (isAway && awayForm > 0)) {
    const pts = isHome ? homeForm : awayForm
    const label = isHome ? m.homeTeam : m.awayTeam
    parts.push(`Forme ${label} ${pts}/15`)
  }

  const c = extras.confluence
  if (c && c.adjustments && c.adjustments.length > 0) parts.push(`Confluence ${c.adjustments.length} ajust.`)
  else parts.push('Confluence ✓')
  if (extras.margin >= 8) parts.push('Signal stable')
  return parts.join(' • ')
}

function toTsMs(m) {
  const raw = m.startTimestamp
  if (raw == null || raw === 0) return 0
  if (typeof raw === 'string' && raw.includes('T')) return new Date(raw).getTime()
  const n = parseInt(raw)
  if (isNaN(n) || n === 0) return 0
  return n > 1e11 ? n : n * 1000
}

// ── Sélection principale ─────────────────────────────────────────
/**
 * selectTopPicksOfDay — retourne les meilleurs picks STRICTS du jour.
 * @param {object} opts { limit = 5, days = 14, markets = null (tous) }
 *   markets : ['1X2'] | ['Over 2.5'] | ['BTTS'] | combinaison
 * @returns {Promise<{picks, generatedAt, analyzed, rejected, filters}>}
 */
async function selectTopPicksOfDay({ limit = DEFAULT_LIMIT, days = 14, markets = null } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const database = require('../core/database')

  let matches = []
  try {
    matches = await database.getMatchesByStatuses(['scheduled', 'upcoming', 'NOT_STARTED', 'NS'], { limit: 600 })
  } catch (e) {
    logger.warn(`[TOP-PICKS] DB read failed: ${e.message}`)
    return { picks: [], generatedAt: new Date().toISOString(), analyzed: 0, rejected: {}, filters: {} }
  }

  const now = Date.now()
  // C10 : matchs NON commenc�s uniquement (gr�ce 30 min kick-off)
  const windowStart = now - 30 * 60 * 1000
  const windowEnd = now + days * 24 * 3600 * 1000

  const analyzed = []
  const rejected = { overconfident: 0, veto: 0, filters: 0, noOdds: 0, window: 0, reserve: 0 }

  for (const m of matches) {
    let tsMs = toTsMs(m)
    if (!tsMs) {
      try {
        const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
        if (data && data.startTimestamp) tsMs = toTsMs({ startTimestamp: data.startTimestamp })
      } catch {
        /* ignore */
      }
    }
    if (!tsMs || tsMs < windowStart || tsMs > windowEnd) {
      rejected.window++
      continue
    }
    if (isReserve(m.homeTeam) || isReserve(m.awayTeam)) {
      rejected.reserve++
      continue
    }

    const candidates = buildCandidates(m, markets)
    if (candidates.length === 0) {
      rejected.noOdds++
      continue
    }

    // ── Blue Band / Data Sufficiency (UNE SEULE fois par match, pas par candidat) ─
    let suffResult = null
    const suffSvc = getSuffSvc()
    if (suffSvc) {
      try {
        suffResult = await suffSvc.getFastSufficiencyScore(m.homeTeam, m.awayTeam, {
          dataSources: {
            statsbomb_open_data: !!(m.home_xg && m.away_xg),
            football_data: !!(m.odds_home && m.odds_away),
            clubelo: !!(m.elo_home && m.elo_away),
          },
          sourcesUsed: [
            m.odds_home ? 'football_data' : null,
            m.home_xg ? 'statsbomb_open_data' : null,
            m.elo_home ? 'clubelo' : null,
          ].filter(Boolean),
        })
      } catch (e) {
        logger.warn(`[TOP-PICKS] BlueBand check failed for ${m.homeTeam} vs ${m.awayTeam}: ${e.message}`)
      }
    }

    for (const candidate of candidates) {
      const { confluence, overconf } = await runSafetyGuards(m, candidate)
      if (overconf.veto) {
        rejected.overconfident++
        continue
      }
      if (confluence && confluence.veto) {
        rejected.veto++
        continue
      }
      // ── Blue Band guard (réutilise suffResult computé ci-dessus) ─────────────
      if (suffSvc && suffResult) {
        candidate.blueBand = !!suffResult.blueBand
        candidate.dataSufficiencyScore = suffResult.score || 0
        candidate.dataSufficiencyLevel = suffResult.level || 'low'
        if (!suffResult.blueBand) {
          candidate.rejectedReason = `data_insufficient:score=${suffResult.score}`
          rejected.noOdds++
          continue
        }
      }
      // Filtres STRICTS (edge / EV / proba calibrée)
      if (candidate.edge < MIN_EDGE_PCT || candidate.ev < MIN_EV) {
        rejected.filters++
        continue
      }
      if (candidate.modelProb < PROB_MIN || candidate.modelProb > PROB_MAX) {
        rejected.overconfident++
        continue
      }

      const { qualityScore, margin, stability, adjustedConf } = computeQualityScore(m, candidate, confluence)
      analyzed.push({ m, candidate, confluence, qualityScore, margin, stability, adjustedConf })
    }
  }

  analyzed.sort(
    (a, b) => b.qualityScore - a.qualityScore || b.candidate.edge - a.candidate.edge || b.candidate.ev - a.candidate.ev
  )
  const top = analyzed.slice(0, cappedLimit)

  const picks = top.map(({ m, candidate, confluence, qualityScore, margin }) => ({
    matchId: m.id,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    leagueName: m.league || m.tournament_name || 'Unknown',
    matchTime: toTsMs(m) ? new Date(toTsMs(m)).toISOString() : null,
    marketType: candidate.marketType,
    recommendedPick: candidate.recommendedPick,
    odds: round(candidate.odds, 2),
    modelProbability: round(candidate.modelProb, 1),
    edgePct: round(candidate.edge, 2),
    ev: round(candidate.ev, 4),
    stakeRecommendation: `${round(candidate.kelly, 1)}%`,
    reasoningSummary: buildReasoning(m, candidate, { confluence, margin }),
    qualityScore,
    blueBand: !!(candidate.blueBand),
    dataSufficiencyScore: candidate.dataSufficiencyScore || 0,
    dataSufficiencyLevel: candidate.dataSufficiencyLevel || 'low',
  }))

  return {
    picks,
    generatedAt: new Date().toISOString(),
    analyzed: analyzed.length,
    rejected,
    filters: { edgePct: MIN_EDGE_PCT, ev: MIN_EV, probMin: PROB_MIN, probMax: PROB_MAX },
  }
}

// ── Plan "Stables" (Double Chance, probas calibrées) ─────────────
/**
 * selectStablePicks — picks à haut taux de réussite et EV positif honnête.
 *
 * Utilise uniquement la Double Chance (1X / X2 / 12) : cotes RÉELLES du
 * marché + proba calibrée empiriquement (courbe DC : ~69 % honnête, contre
 * 63 % réel pour les annonces ≥ 80 %). La réussite réelle de la DC est
 * ~68-71 % ; ces picks ne sont retenus que si la cote combinée réelle
 * couvre le risque (EV ≥ +2 %).
 *
 * @param {object} opts { limit = 5, days = 14 }
 * @returns {Promise<{picks, generatedAt, analyzed, rejected, filters}>}
 */
async function selectStablePicks({ limit = DEFAULT_LIMIT, days = 14 } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const database = require('../core/database')

  let matches = []
  try {
    matches = await database.getMatchesByStatuses(['scheduled', 'upcoming', 'NOT_STARTED', 'NS'], { limit: 600 })
  } catch (e) {
    logger.warn(`[STABLES] DB read failed: ${e.message}`)
    return { picks: [], generatedAt: new Date().toISOString(), analyzed: 0, rejected: {}, filters: {} }
  }

  const now = Date.now()
  // C10 : matchs NON commenc�s uniquement (gr�ce 30 min kick-off)
  const windowStart = now - 30 * 60 * 1000
  const windowEnd = now + days * 24 * 3600 * 1000
  const cal = getCalibrator()

  const analyzed = []
  const rejected = { noOdds: 0, noProbs: 0, window: 0, reserve: 0, filters: 0 }

  for (const m of matches) {
    let tsMs = toTsMs(m)
    if (!tsMs) {
      try {
        const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
        if (data && data.startTimestamp) tsMs = toTsMs({ startTimestamp: data.startTimestamp })
      } catch {
        /* ignore */
      }
    }
    if (!tsMs || tsMs < windowStart || tsMs > windowEnd) {
      rejected.window++
      continue
    }
    if (isReserve(m.homeTeam) || isReserve(m.awayTeam)) {
      rejected.reserve++
      continue
    }

    const odds = getMatchOdds(m)
    if (!odds.has1x2) {
      rejected.noOdds++
      continue
    }
    const mh = parseFloat(m.home_win_probability) || 0
    const md = parseFloat(m.draw_probability) || 0
    const ma = parseFloat(m.away_win_probability) || 0
    if (!mh || !md || !ma) {
      rejected.noProbs++
      continue
    }

    const fair = ValueBetEngine.deVig(odds.home, odds.draw, odds.away)
    const combos = [
      { pick: '1X', prob: mh + md, o1: odds.home, o2: odds.draw, fairProb: fair.home + fair.draw },
      { pick: 'X2', prob: md + ma, o1: odds.draw, o2: odds.away, fairProb: fair.draw + fair.away },
      { pick: '12', prob: mh + ma, o1: odds.home, o2: odds.away, fairProb: fair.home + fair.away },
    ]

    let best = null
    for (const combo of combos) {
      if (!combo.o1 || !combo.o2) continue
      const combinedOdds = 1 / (1 / combo.o1 + 1 / combo.o2)
      if (combinedOdds <= 1 || combinedOdds < STABLES_MIN_ODDS) continue
      const calProb = cal ? cal.calibrateProb(combo.prob, 'DC') : combo.prob
      if (calProb < STABLES_MIN_PROB) {
        rejected.filters++
        continue
      }
      const ev = (calProb / 100) * combinedOdds - 1
      if (ev < STABLES_MIN_EV) {
        rejected.filters++
        continue
      }
      const kelly = ValueBetEngine.kellyStake(calProb, combinedOdds)
      const candidate = {
        pick: combo.pick,
        prob: combo.prob,
        calProb,
        odds: combinedOdds,
        ev,
        edge: calProb - combo.fairProb,
        kelly,
      }
      if (!best || candidate.ev > best.ev) best = candidate
    }

    if (best) analyzed.push({ m, best })
  }

  analyzed.sort((a, b) => b.best.ev - a.best.ev || b.best.calProb - a.best.calProb)
  const top = analyzed.slice(0, cappedLimit)

  const picks = top.map(({ m, best }) => ({
    matchId: m.id,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    leagueName: m.league || m.tournament_name || 'Unknown',
    matchTime: toTsMs(m) ? new Date(toTsMs(m)).toISOString() : null,
    marketType: 'DC',
    recommendedPick: best.pick,
    odds: round(best.odds, 2),
    modelProbability: round(best.calProb, 1),
    rawProbability: round(best.prob, 1),
    edgePct: round(best.edge, 2),
    ev: round(best.ev, 4),
    stakeRecommendation: `${round(best.kelly, 1)}%`,
    reasoningSummary: `Double chance ${best.pick} • proba calibrée ${round(best.calProb, 1)}% (brut ${round(best.prob, 1)}%) • EV +${round(best.ev * 100, 0)}% • cote réelle ${round(best.odds, 2)}`,
  }))

  return {
    picks,
    generatedAt: new Date().toISOString(),
    analyzed: analyzed.length,
    rejected,
    filters: { probMin: STABLES_MIN_PROB, oddsMin: STABLES_MIN_ODDS, evMin: STABLES_MIN_EV },
  }
}

module.exports = {
  selectTopPicksOfDay,
  selectStablePicks,
  _internal: { buildCandidates, noBetOverconfident, computeQualityScore },
}
