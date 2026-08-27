/**
 * accuracyEngine.js — Métrique de performance UNIFIÉE
 *
 * Source unique de vérité pour l'exactitude des prédictions du moteur.
 * Remplace les deux mesures divergentes (promosport_accuracy_trend.json —
 * backfill ML dégénéré « tout-X » — et retro_accuracy_report.json — oracle
 * du favori avec look-ahead massif). Voir CHANGELOG_AUDIT.md ÉTAPE 1.
 *
 * Principes :
 *  - Périmètre : matchs terminés (scoreHome/scoreAway renseignés), qu'ils soient
 *    dans `matches` (statut FT) ou `historical_matches` (archivés).
 *  - Snapshot au temps T : n'utilise QUE la prédiction et la confiance telles
 *    qu'enregistrées à l'origine (colonne prediction / fullData archivée).
 *    AUCUN recalcul avec des données plus fraîches, aucun backfill rétroactif.
 *  - Whitelist stricte : 1, X, 2, 1X, X2, 12, O<seuil>, U<seuil>,
 *    BTTS YES / BTTS NO (audit BT2 — émis via fullData.btts_pick au temps T).
 *    Tout autre label (RISKY BET, PENDING, …) est EXCLU du calcul et compté
 *    dans `excludedLabels` — jamais ignoré silencieusement.
 *  - Deux vues avec le même code : rolling (7j/30j) et cumulé → seul le filtre
 *    de fenêtre change.
 *  - Métriques : accuracy brute, Brier score, log-loss, courbe de calibration
 *    par bande de 10 %, accuracy par ligue.
 */

const FT_STATUSES = ['FT', 'finished', 'Finished', 'Ended']
const VALID_1X2 = new Set(['1', 'X', '2', '1X', 'X2', '12'])
// Audit BT2 : labels BTTS normalisés (normalizeLabel supprime les espaces :
// 'BTTS YES' -> 'BTTSYES'). Émis par deriveBttsPick() et persistés en
// fullData.btts_pick au temps T.
const BTTS_RE = /^BTTS(YES|NO)$/
const OU_RE = /^[OU](\d+(?:\.\d+)?)$/
// Audit Q1 : marchés Corners (O/U ligne, défaut 9.5) et HT (O/U 0.5).
const CORNER_RE = /^CORNERS(OVER|UNDER)(\d+(?:\.\d+)?)$/
const HT_RE = /^HT(OVER|UNDER)0\.5$/
// Quarter-Kelly : cap explicite à 2 % du bankroll (évite les stakes gonflés).
const KELLY_FRAC = 0.25
const KELLY_CAP_PCT = 2.0

let _db = null
function getDb(injected) {
  if (injected) return injected
  if (_db) return _db
  _db = require('../core/database').db
  return _db
}

function normalizeLabel(raw) {
  if (raw == null) return null
  const s = String(raw).toUpperCase().trim().replace(/\s+/g, '')
  if (s === '') return null
  return s
}

function is1x2(label) {
  return VALID_1X2.has(label)
}

function isBTTS(label) {
  return BTTS_RE.test(label)
}

function isOU(label) {
  return OU_RE.test(label)
}

function isCorner(label) {
  return CORNER_RE.test(label)
}

function isHT(label) {
  return HT_RE.test(label)
}

// Marché d'un pick : '1X2' (simple), 'DC' (double chance), 'OU' (over/under).
function marketKey(label) {
  const p = normalizeLabel(label)
  if (!p) return null
  if (p === '1' || p === 'X' || p === '2') return '1X2'
  if (p === '1X' || p === 'X2' || p === '12') return 'DC'
  if (isBTTS(p)) return 'BTTS'
  if (isOU(p)) return 'OU'
  if (isCorner(p)) return 'CORNER'
  if (isHT(p)) return 'HT'
  return null
}

function isAllowed(label, marketFilter) {
  if (is1x2(label)) return marketFilter === 'all' || marketFilter === '1x2'
  if (isBTTS(label)) return marketFilter === 'all' || marketFilter === 'btts'
  if (isOU(label)) return marketFilter === 'all' || marketFilter === 'over_under'
  if (isCorner(label)) return marketFilter === 'all' || marketFilter === 'corners'
  if (isHT(label)) return marketFilter === 'all' || marketFilter === 'ht'
  return false
}

function actualOutcome(scoreHome, scoreAway) {
  if (scoreHome == null || scoreAway == null) return null
  if (scoreHome > scoreAway) return '1'
  if (scoreHome < scoreAway) return '2'
  return 'X'
}

/**
 * Une prédiction est correcte si :
 *  - 1X2 simple : pick === résultat
 *  - 1X2 double chance (1X/X2/12) : le résultat appartient au pick
 *  - O/U : total de buts au-dessus (O) ou en dessous (U) du seuil
 */
function isCorrect(pick, actual, scoreHome, scoreAway, ctx) {
  if (isCorner(pick)) {
    const ch = ctx?.cornersHome
    const ca = ctx?.cornersAway
    if (ch == null || ca == null) return null
    const m = pick.match(CORNER_RE)
    if (!m) return null
    const line = parseFloat(m[2])
    const over = m[1] === 'OVER'
    const total = Number(ch) + Number(ca)
    const actualCorner = total > line ? `CORNERSOVER${m[2]}` : `CORNERSUNDER${m[2]}`
    return pick === actualCorner
  }
  if (isHT(pick)) {
    const hth = ctx?.htHome
    const hta = ctx?.htAway
    if (hth == null || hta == null) return null
    const total = Number(hth) + Number(hta)
    const actualHT = total > 0.5 ? 'HTOVER0.5' : 'HTUNDER0.5'
    return pick === actualHT
  }
  if (isBTTS(pick)) {
    // Audit BT2 : réel BTTS dérivé des scores finaux (les deux équipes marquent)
    if (scoreHome == null || scoreAway == null) return null
    const actualBtts = scoreHome > 0 && scoreAway > 0 ? 'BTTSYES' : 'BTTSNO'
    return pick === actualBtts
  }
  if (is1x2(pick)) {
    if (pick.length === 1) return pick === actual
    return pick.includes(actual)
  }
  if (isOU(pick)) {
    if (scoreHome == null || scoreAway == null) return null
    const total = scoreHome + scoreAway
    const threshold = parseFloat(pick.slice(1))
    return pick[0] === 'O' ? total > threshold : total < threshold
  }
  return null
}

/**
 * Probabilité de l'issue prédite (pour la calibration), en % (0-100).
 * Retourne null si aucune probabilité exploitable enregistrée au temps T.
 */
function pickProbability(pick, probs) {
  if (!probs) return null
  const { p1, px, p2, pBtts, pCorner, pHT } = probs
  if (isBTTS(pick)) {
    return pBtts != null && Number.isFinite(pBtts) ? pBtts * 100 : null
  }
  if (isCorner(pick)) {
    return pCorner != null && Number.isFinite(pCorner) ? pCorner * 100 : null
  }
  if (isHT(pick)) {
    return pHT != null && Number.isFinite(pHT) ? pHT * 100 : null
  }
  if (p1 == null || px == null || p2 == null) return null
  if (is1x2(pick)) {
    let prob
    if (pick === '1') prob = p1
    else if (pick === 'X') prob = px
    else if (pick === '2') prob = p2
    else if (pick === '1X') prob = p1 + px
    else if (pick === 'X2') prob = px + p2
    else if (pick === '12') prob = p1 + p2
    else prob = Math.max(p1, px, p2)
    return prob * 100
  }
  if (isOU(pick)) {
    return Math.max(p1, px, p2) * 100 // proxy : probs 1X2 disponibles seulement
  }
  return null
}

function computeLogLoss(p1, px, p2, actual) {
  if (p1 == null || px == null || p2 == null || !actual) return null
  const eps = 1e-12
  const q = actual === '1' ? p1 : actual === 'X' ? px : actual === '2' ? p2 : null
  if (q == null || q <= 0) return null
  return -Math.log(Math.max(q, eps))
}

function computeBrier(p1, px, p2, actual) {
  if (p1 == null || px == null || p2 == null || !actual) return null
  const truth = [0, 0, 0]
  if (actual === '1') truth[0] = 1
  else if (actual === 'X') truth[1] = 1
  else if (actual === '2') truth[2] = 1
  else return null
  const pred = [p1, px, p2]
  return pred.reduce((acc, v, i) => acc + (v - truth[i]) * (v - truth[i]), 0)
}

/**
 * Cotes de l'issue prédite (retour nul si absentes ou invalides).
 * Les cotes doivent être strictement > 1 (sinon non pariable) : un match sans
 * cotes exploitables est SKIP — jamais une valeur par défaut biaisée.
 */
function validOdds(v) {
  return v != null && Number(v) > 1.0 ? Number(v) : null
}

function combinedOdds(o1, o2) {
  const a = validOdds(o1)
  const b = validOdds(o2)
  if (a == null || b == null) return null
  return 1 / ((1 / a) + (1 / b))
}

function pickOdds(pick, odds) {
  if (!odds) return null
  if (isOU(pick)) {
    // Audit Phase 1 FD-Odds : cotes O/U archivées (colonnes odds_over25/25,
    // alimentées par le bridge football-data). Seuil 2.5 uniquement.
    const thr = parseFloat(pick.slice(1))
    if (thr === 2.5) {
      return pick[0] === 'O' ? validOdds(odds.over25) : validOdds(odds.under25)
    }
    return null
  }
  if (isBTTS(pick)) {
    // Audit BT2 : cotes BTTS archivées (colonnes odds_btts_yes/no, rares)
    if (pick === 'BTTSYES') return validOdds(odds.bttsYes)
    if (pick === 'BTTSNO') return validOdds(odds.bttsNo)
    return null
  }
  if (isCorner(pick)) {
    // Audit C : ROI Corners — cotes archivées (odds_corner_over/under, ligne 9.5)
    return pick.includes('OVER') ? validOdds(odds.cornerOver) : validOdds(odds.cornerUnder)
  }
  if (isHT(pick)) {
    // Audit C : ROI HT — cotes archivées (odds_ht_over/under, ligne 0.5)
    return pick.includes('OVER') ? validOdds(odds.htOver) : validOdds(odds.htUnder)
  }
  if (is1x2(pick)) {
    if (pick === '1') return validOdds(odds.home)
    if (pick === 'X') return validOdds(odds.draw)
    if (pick === '2') return validOdds(odds.away)
    if (pick === '1X') return combinedOdds(odds.home, odds.draw)
    if (pick === 'X2') return combinedOdds(odds.draw, odds.away)
    if (pick === '12') return combinedOdds(odds.home, odds.away)
  }
  return null // O/U : pas de cotes enregistrées → exclu du ROI (compté à part)
}

/**
 * Profit d'un pari en Quarter-Kelly (fraction × 0.25), plafonné explicitement
 * à KELLY_CAP_PCT % du bankroll (paramètre par défaut : 1.0 = 100 %).
 * Retourne null si aucun stake enregistré ou si odds invalides.
 */
function kellyStake(stakePct, odds) {
  const o = validOdds(odds)
  if (stakePct == null || Number(stakePct) <= 0 || o == null) return null
  const frac = (Number(stakePct) / 100) * KELLY_FRAC
  return Math.min(frac, KELLY_CAP_PCT / 100)
}

/**
 * Extraction de la prédiction depuis une ligne `matches` (colonnes directes).
 * Audit P3 : si les colonnes odds_* sont vides (cause n°1 des 1472 exclusions
 * ROI), on retombe sur les cotes figées dans fullData au moment du pronostic.
 * Audit BT2 : si fullData.btts_pick existe (persisté au temps T par BT1),
 * émet un SECOND record marché BTTS — mesuré comme DC/OU/1X2.
 * @returns {Array} 0 à 2 records
 */
function recordsFromMatches(r, options) {
  const out = []
  const pick = normalizeLabel(r.prediction)
  const actual = actualOutcome(r.scoreHome, r.scoreAway)
  const confidence = r.confidence != null ? Number(r.confidence) : null

  let fd = {}
  if (r.fullData) {
    try {
      fd = typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData || {}
    } catch {
      fd = {}
    }
  }

  const probs =
    r.home_win_probability != null || r.draw_probability != null || r.away_win_probability != null
      ? {
          p1: r.home_win_probability != null ? r.home_win_probability / 100 : null,
          px: r.draw_probability != null ? r.draw_probability / 100 : null,
          p2: r.away_win_probability != null ? r.away_win_probability / 100 : null,
        }
      : {
          p1: fd.home_win_probability != null ? fd.home_win_probability / 100 : null,
          px: fd.draw_probability != null ? fd.draw_probability / 100 : null,
          p2: fd.away_win_probability != null ? fd.away_win_probability / 100 : null,
        }

  const fdOdds = {
    home: fd.odds_home ?? fd.home_odds ?? fd.odds?.home_win,
    draw: fd.odds_draw ?? fd.draw_odds ?? fd.odds?.draw,
    away: fd.odds_away ?? fd.away_odds ?? fd.odds?.away_win,
    bttsYes: fd.odds_btts_yes ?? fd.btts_yes_odds ?? fd.odds?.btts_yes,
    bttsNo: fd.odds_btts_no ?? fd.btts_no_odds ?? fd.odds?.btts_no,
    over25: fd.odds_over25 ?? fd.odds?.over25,
    under25: fd.odds_under25 ?? fd.odds?.under25,
    cornerOver: fd.odds_corner_over ?? fd.odds?.corner_over,
    cornerUnder: fd.odds_corner_under ?? fd.odds?.corner_under,
    htOver: fd.odds_ht_over ?? fd.odds?.ht_over,
    htUnder: fd.odds_ht_under ?? fd.odds?.ht_under,
  }

  // Audit Prio 1 (2026-08-26) : marquage low-data pour permettre la mesure
  // séparée de la performance des picks ZERO-DATA / insufficient_data.
  // Sources (par ordre de priorité) :
  //   - colonne matches.insufficient_data (QuantumQuantEngine / HONESTY GATE)
  //   - fullData.zero_data_rescue  (marking Python low_data_handler)
  //   - fullData.is_low_data_prediction (marking Python low_data_handler)
  const isLowDataMatch =
    Number(r.insufficient_data) === 1 ||
    fd.zero_data_rescue === true ||
    fd.is_low_data_prediction === true

  const primary = buildRecord(
    {
      matchId: r.id,
      league: r.league || 'Unknown',
      pick,
      actual,
      scoreHome: r.scoreHome,
      scoreAway: r.scoreAway,
      confidence,
      probs,
      odds: {
        home: validOdds(r.odds_home) != null ? r.odds_home : fdOdds.home,
        draw: validOdds(r.odds_draw) != null ? r.odds_draw : fdOdds.draw,
        away: validOdds(r.odds_away) != null ? r.odds_away : fdOdds.away,
        over25: validOdds(r.odds_over25) != null ? r.odds_over25 : fdOdds.over25,
        under25: validOdds(r.odds_under25) != null ? r.odds_under25 : fdOdds.under25,
        cornerOver: validOdds(r.odds_corner_over) != null ? r.odds_corner_over : fdOdds.cornerOver,
        cornerUnder: validOdds(r.odds_corner_under) != null ? r.odds_corner_under : fdOdds.cornerUnder,
        htOver: validOdds(r.odds_ht_over) != null ? r.odds_ht_over : fdOdds.htOver,
        htUnder: validOdds(r.odds_ht_under) != null ? r.odds_ht_under : fdOdds.htUnder,
      },
      kellyStakePct: r.kelly_stake != null ? Number(r.kelly_stake) : null,
      source: 'matches',
      ts: r.startTimestamp || parseDateTs(r.timestamp),
      cornersHome: r.corners_home,
      cornersAway: r.corners_away,
      htHome: r.score_home_ht,
      htAway: r.score_away_ht,
      isLowData: isLowDataMatch,
    },
    options
  )
  if (primary) out.push(primary)

  // ── Record BTTS secondaire (audit BT2) ──
  const btsPick = normalizeLabel(r.btts_pick ?? fd.btts_pick ?? null)
  if (btsPick && isBTTS(btsPick)) {
    const pBttsRaw = r.btts_prob ?? fd.btts_prob ?? fd.btts_pick_prob ?? null
    const pBtts =
      pBttsRaw != null && Number.isFinite(Number(pBttsRaw)) && Number(pBttsRaw) > 0
        ? Number(pBttsRaw) / 100
        : null
    const brec = buildRecord(
      {
        matchId: r.id + '|BTTS',
        league: r.league || 'Unknown',
        pick: btsPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pBtts != null ? +(pBtts * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pBtts },
        odds: {
          home: null,
          draw: null,
          away: null,
          bttsYes: validOdds(r.odds_btts_yes) != null ? r.odds_btts_yes : fdOdds.bttsYes,
          bttsNo: validOdds(r.odds_btts_no) != null ? r.odds_btts_no : fdOdds.bttsNo,
        },
        kellyStakePct: null,
        source: 'matches|BTTS',
        ts: r.startTimestamp || parseDateTs(r.timestamp),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (brec) out.push(brec)
  }

  // ── Record Corners secondaire (audit Q1) ──
  const corPick = normalizeLabel(r.corner_pick ?? fd.corner_pick ?? null)
  if (corPick && isCorner(corPick)) {
    const pCorRaw =
      r.corner_pick_prob ?? fd.corner_pick_prob ?? fd.corner_prob ?? null
    const pCorner =
      pCorRaw != null && Number.isFinite(Number(pCorRaw)) && Number(pCorRaw) > 0
        ? Number(pCorRaw) / 100
        : null
    const crec = buildRecord(
      {
        matchId: r.id + '|CORNER',
        league: r.league || 'Unknown',
        pick: corPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pCorner != null ? +(pCorner * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pCorner },
        odds: { home: null, draw: null, away: null, bttsYes: null, bttsNo: null },
        kellyStakePct: null,
        source: 'matches|CORNER',
        ts: r.startTimestamp || parseDateTs(r.timestamp),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (crec) out.push(crec)
  }

  // ── Record HT secondaire (audit Q1) ──
  const htPick = normalizeLabel(r.ht_pick ?? fd.ht_pick ?? null)
  if (htPick && isHT(htPick)) {
    const pHTRaw = r.ht_pick_prob ?? fd.ht_pick_prob ?? fd.ht_prob ?? null
    const pHT =
      pHTRaw != null && Number.isFinite(Number(pHTRaw)) && Number(pHTRaw) > 0
        ? Number(pHTRaw) / 100
        : null
    const hrec = buildRecord(
      {
        matchId: r.id + '|HT',
        league: r.league || 'Unknown',
        pick: htPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pHT != null ? +(pHT * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pHT },
        odds: { home: null, draw: null, away: null, bttsYes: null, bttsNo: null },
        kellyStakePct: null,
        source: 'matches|HT',
        ts: r.startTimestamp || parseDateTs(r.timestamp),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (hrec) out.push(hrec)
  }

  return out
}

/**
 * Extraction de la prédiction depuis une ligne `historical_matches`.
 * Les colonnes prediction/confidence n'existent pas : elles sont dans fullData
 * (archivée telle quelle au moment du pronostic → snapshot au temps T).
 * Audit BT2 : émet aussi le record BTTS secondaire si fullData.btts_pick.
 * @returns {Array} 0 à 2 records
 */
function recordsFromHistorical(r, options) {
  let fd = {}
  try {
    fd = JSON.parse(r.fullData || '{}')
  } catch {
    fd = {}
  }

  const pick = normalizeLabel(
    fd.prediction ?? fd.quant?.main_pick ?? fd.quant?.all_picks?.[0]?.val ?? null
  )
  const actual = actualOutcome(r.scoreHome, r.scoreAway)
  const confidence = fd.confidence != null ? Number(fd.confidence) : fd.quant?.confidence ?? null

  const qmr = fd.quant?.markets?.match_result
  const p1 =
    fd.home_win_probability != null
      ? fd.home_win_probability / 100
      : qmr?.['1']?.prob != null
        ? qmr['1'].prob
        : null
  const px =
    fd.draw_probability != null
      ? fd.draw_probability / 100
      : qmr?.X?.prob != null
        ? qmr.X.prob
        : null
  const p2 =
    fd.away_win_probability != null
      ? fd.away_win_probability / 100
      : qmr?.['2']?.prob != null
        ? qmr['2'].prob
        : null
  const probs = p1 != null || px != null || p2 != null ? { p1, px, p2 } : null

  // Audit Prio 1 (2026-08-26) : même marquage low-data côté archive.
  // fullData.archivé n'est PAS régénéré — on lit les flags tels qu'écrits à
  // l'époque par QuantumQuantEngine / HONESTY GATE / Python low_data_handler.
  const isLowDataHist =
    Number(r.insufficient_data) === 1 ||
    fd.insufficient_data === 1 ||
    fd.zero_data_rescue === true ||
    fd.is_low_data_prediction === true

  const out = []
  const primary = buildRecord(
    {
      matchId: r.id,
      league: r.league || 'Unknown',
      pick,
      actual,
      scoreHome: r.scoreHome,
      scoreAway: r.scoreAway,
      confidence,
      probs,
      odds: {
        home: fd.odds_home ?? fd.home_odds ?? fd.odds?.home_win ?? null,
        draw: fd.odds_draw ?? fd.draw_odds ?? fd.odds?.draw ?? null,
        away: fd.odds_away ?? fd.away_odds ?? fd.odds?.away_win ?? null,
        over25: fd.odds_over25 ?? fd.odds?.over25 ?? null,
        under25: fd.odds_under25 ?? fd.odds?.under25 ?? null,
        cornerOver: r.odds_corner_over != null ? r.odds_corner_over : (fd.odds_corner_over ?? fd.odds?.corner_over ?? null),
        cornerUnder: r.odds_corner_under != null ? r.odds_corner_under : (fd.odds_corner_under ?? fd.odds?.corner_under ?? null),
        htOver: r.odds_ht_over != null ? r.odds_ht_over : (fd.odds_ht_over ?? fd.odds?.ht_over ?? null),
        htUnder: r.odds_ht_under != null ? r.odds_ht_under : (fd.odds_ht_under ?? fd.odds?.ht_under ?? null),
      },
      kellyStakePct: fd.kelly_stake != null ? Number(fd.kelly_stake) : null,
      source: 'historical_matches',
      ts: parseDateTs(r.timestamp) || parseDateTs(r.archived_at),
      cornersHome: r.corners_home,
      cornersAway: r.corners_away,
      htHome: r.score_home_ht,
      htAway: r.score_away_ht,
      isLowData: isLowDataHist,
    },
    options
  )
  if (primary) out.push(primary)

  // ── Record BTTS secondaire (audit BT2) ──
  const btsPick = normalizeLabel(fd.btts_pick ?? null)
  if (btsPick && isBTTS(btsPick)) {
    const pBttsRaw =
      fd.btts_prob ?? fd.btts_pick_prob ?? fd.quant?.markets?.btts?.YES?.prob ?? null
    const pBtts =
      pBttsRaw != null && Number.isFinite(Number(pBttsRaw)) && Number(pBttsRaw) > 0
        ? Number(pBttsRaw) <= 1
          ? Number(pBttsRaw)
          : Number(pBttsRaw) / 100
        : null
    const brec = buildRecord(
      {
        matchId: r.id + '|BTTS',
        league: r.league || 'Unknown',
        pick: btsPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pBtts != null ? +(pBtts * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pBtts },
        odds: {
          home: null,
          draw: null,
          away: null,
          bttsYes: fd.odds_btts_yes ?? fd.btts_yes_odds ?? fd.odds?.btts_yes ?? null,
          bttsNo: fd.odds_btts_no ?? fd.btts_no_odds ?? fd.odds?.btts_no ?? null,
        },
        kellyStakePct: null,
        source: 'historical_matches|BTTS',
        ts: parseDateTs(r.timestamp) || parseDateTs(r.archived_at),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (brec) out.push(brec)
  }

  // ── Record Corners secondaire (audit Q1) ──
  const corPick = normalizeLabel(fd.corner_pick ?? null)
  if (corPick && isCorner(corPick)) {
    const pCorRaw = fd.corner_pick_prob ?? fd.corner_prob ?? null
    const pCorner =
      pCorRaw != null && Number.isFinite(Number(pCorRaw)) && Number(pCorRaw) > 0
        ? Number(pCorRaw) <= 1
          ? Number(pCorRaw)
          : Number(pCorRaw) / 100
        : null
    const crec = buildRecord(
      {
        matchId: r.id + '|CORNER',
        league: r.league || 'Unknown',
        pick: corPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pCorner != null ? +(pCorner * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pCorner },
        odds: { home: null, draw: null, away: null, bttsYes: null, bttsNo: null },
        kellyStakePct: null,
        source: 'historical_matches|CORNER',
        ts: parseDateTs(r.timestamp) || parseDateTs(r.archived_at),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (crec) out.push(crec)
  }

  // ── Record HT secondaire (audit Q1) ──
  const htPick = normalizeLabel(fd.ht_pick ?? null)
  if (htPick && isHT(htPick)) {
    const pHTRaw = fd.ht_pick_prob ?? fd.ht_prob ?? null
    const pHT =
      pHTRaw != null && Number.isFinite(Number(pHTRaw)) && Number(pHTRaw) > 0
        ? Number(pHTRaw) <= 1
          ? Number(pHTRaw)
          : Number(pHTRaw) / 100
        : null
    const hrec = buildRecord(
      {
        matchId: r.id + '|HT',
        league: r.league || 'Unknown',
        pick: htPick,
        actual,
        scoreHome: r.scoreHome,
        scoreAway: r.scoreAway,
        confidence: pHT != null ? +(pHT * 100).toFixed(1) : null,
        probs: { p1: null, px: null, p2: null, pHT },
        odds: { home: null, draw: null, away: null, bttsYes: null, bttsNo: null },
        kellyStakePct: null,
        source: 'historical_matches|HT',
        ts: parseDateTs(r.timestamp) || parseDateTs(r.archived_at),
        cornersHome: r.corners_home,
        cornersAway: r.corners_away,
        htHome: r.score_home_ht,
        htAway: r.score_away_ht,
      },
      options
    )
    if (hrec) out.push(hrec)
  }

  return out
}

function parseDateTs(v) {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isNaN(n)) return n
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : d
}

function buildRecord(base, options) {
  const { from, to, marketFilter } = options
  if (base.pick == null) return null
  if (!isAllowed(base.pick, marketFilter)) return null
  if (base.ts != null && from != null && base.ts < from) return null
  if (base.ts != null && to != null && base.ts > to) return null
  // Le résultat doit être définitif
  if (base.actual == null) return null
  return base
}

function calibrationBands(pickProb) {
  if (pickProb == null) return null
  const clamped = Math.max(0, Math.min(100, pickProb))
  const idx = Math.min(9, Math.floor(clamped / 10))
  return { min: idx * 10, max: Math.min(100, (idx + 1) * 10), band: `${idx * 10}-${Math.min(100, (idx + 1) * 10)}` }
}

/**
 * Métrique unifiée.
 *
 * @param {object} [options]
 * @param {number|string} [options.from]  — borne basse (ts ms ou date ISO)
 * @param {number|string} [options.to]    — borne haute (ts ms ou date ISO)
 * @param {'all'|'1x2'|'over_under'} [options.marketFilter='all']
 * @param {object} [options.db]           — injectable pour les tests
 * @returns {object} rapport structuré (toujours valide, jamais de NaN)
 */
function computeAccuracy(options = {}) {
  const from = options.from != null ? parseDateTs(options.from) : null
  const to = options.to != null ? parseDateTs(options.to) : null
  const marketFilter = options.marketFilter || 'all'
  const db = getDb(options.db)

  const records = []
  const excludedLabels = {}
  let noPredictionCount = 0
  let pendingCount = 0
  let finishedCount = 0

  try {
    const liveRows = db
      .prepare(`SELECT * FROM matches WHERE status IN (${FT_STATUSES.map(() => '?').join(',')})`)
      .all(...FT_STATUSES)
    for (const r of liveRows) {
      finishedCount++
      const recs = recordsFromMatches(r, { from, to, marketFilter })
      if (recs.length) records.push(...recs)
      else {
        const pick = normalizeLabel(r.prediction)
        if (pick === 'PENDING') {
          pendingCount++
        } else if (pick && !isAllowed(pick, marketFilter)) {
          excludedLabels[pick] = (excludedLabels[pick] || 0) + 1
        } else if (!pick) {
          noPredictionCount++
        }
      }
    }
  } catch {
    /* matches absente dans certains contextes de test — non bloquant */
  }

  let histRows = []
  try {
    histRows = db.prepare(`SELECT * FROM historical_matches`).all()
  } catch {
    histRows = []
  }
  for (const r of histRows) {
    finishedCount++
    const recs = recordsFromHistorical(r, { from, to, marketFilter })
    if (recs.length) records.push(...recs)
    else {
      let fd = {}
      try {
        fd = JSON.parse(r.fullData || '{}')
      } catch {}
      if (fd.verdict === 'PENDING' || fd.risk_label === 'PENDING') {
        pendingCount++
      } else {
        const pick = normalizeLabel(fd.prediction ?? fd.quant?.main_pick ?? fd.quant?.all_picks?.[0]?.val ?? null)
        if (pick && !isAllowed(pick, marketFilter)) {
          excludedLabels[pick] = (excludedLabels[pick] || 0) + 1
        } else if (!pick) {
          noPredictionCount++
        }
      }
    }
  }

  const N = records.length
  let evaluated = 0
  let correct = 0
  let pushCount = 0
  // Audit Prio 1 (2026-08-26) : mesure séparée des picks low-data / ZERO-DATA
  // (marqués via rec.isLowData, propagé depuis matches.insufficient_data ou
  // fullData.zero_data_rescue / is_low_data_prediction). Lecture seule, aucun
  // recalcul : permet de comparer accuracy générale vs accuracy low-data.
  let lowDataCount = 0
  let lowDataCorrect = 0
  let lowDataPush = 0
  let logLossSum = 0
  let logLossCount = 0
  let brierSum = 0
  let brierCount = 0
  // ROI (flat 1u baseline + Quarter-Kelly cap 2 %)
  let roiBets = 0
  let roiExcluded = 0
  let flatStaked = 0
  let flatProfit = 0
  let kellyBets = 0
  let kellyStaked = 0
  let kellyProfit = 0
  // Audit P3 : vue ROI alternative filtrée sur l'espérance positive +
  // diagnostic cotes (gagnants vs perdants, cotes manquantes par marché).
  let evBets = 0
  let evStaked = 0
  let evProfit = 0
  let nOddsWinners = 0
  let sumOddsWinners = 0
  let nOddsLosers = 0
  let sumOddsLosers = 0
  const oddsMissingByMarket = {}
  const calib = {}
  const leagueMap = {}
  const byMarket = {} // { 1X2 | DC | OU } → réussite + cote moyenne + ROI flat

  // Audit A/B (2026-08-26) : répartition par bracket de confiance (ex: 70-80%) —
  // permet de mesurer la sur-confiance (cf. "réel ≈ 41% (75)" issu de
  // backtest_results.json bracketAccuracy). Clé = label de bracket.
  const byConfidenceBracket = {}
  const confBracket = (c) => {
    if (c == null || Number.isNaN(Number(c))) return 'unknown'
    const v = Number(c)
    if (v < 50) return '0-50'
    if (v < 60) return '50-60'
    if (v < 70) return '60-70'
    if (v < 80) return '70-80'
    if (v < 90) return '80-90'
    return '90+'
  }

  for (const rec of records) {
    const ok = isCorrect(rec.pick, rec.actual, rec.scoreHome, rec.scoreAway, rec)
    if (ok === null) continue
    evaluated++
    if (ok) correct++
    else if (isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))) {
      pushCount++ // O/U exactement sur le seuil → push
    }

    // Audit Prio 1 (2026-08-26) : comptage low-data (snapshot au temps T, aucun
    // recalcul). Un push O/U n'est ni correct ni faux — compté à part.
    if (rec.isLowData) {
      lowDataCount++
      if (ok === true) lowDataCorrect++
      else if (isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))) {
        lowDataPush++
      }
    }

    // Audit A/B (2026-08-26) : accumulation par bracket de confiance. Même règle
    // que l'accuracy globale — un push O/U est exclu du dénominateur.
    const bk = confBracket(rec.confidence)
    if (!byConfidenceBracket[bk]) byConfidenceBracket[bk] = { count: 0, correct: 0, push: 0 }
    byConfidenceBracket[bk].count++
    if (ok === true) byConfidenceBracket[bk].correct++
    else if (isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))) {
      byConfidenceBracket[bk].push++
    }

    const ll = computeLogLoss(rec.probs?.p1, rec.probs?.px, rec.probs?.p2, rec.actual)
    if (ll != null) {
      logLossSum += ll
      logLossCount++
    }
    const br = computeBrier(rec.probs?.p1, rec.probs?.px, rec.probs?.p2, rec.actual)
    if (br != null) {
      brierSum += br
      brierCount++
    }

    // ROI : cotes de l'issue prédite. Absentes ou ≤ 1.0 → SKIP (jamais de
    // division par une cote invalide). O/U sans cotes → exclu compté à part.
    const odds = pickOdds(rec.pick, rec.odds)
    if (odds != null) {
      const isPush = isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))
      const isWin = ok === true
      // Baseline : 1 unité plate par pari (push = remboursé, profit 0)
      roiBets++
      flatStaked += 1
      if (isWin) {
        flatProfit += odds - 1
        nOddsWinners++
        sumOddsWinners += odds
      } else if (!isPush) {
        flatProfit -= 1
        nOddsLosers++
        sumOddsLosers += odds
      }
      // Vue EV-filtrée (audit P3) : on ne compte comme « pariable » que les
      // picks dont l'espérance modèle est positive : p × cote > 1.05.
      const pPick = pickProbability(rec.pick, rec.probs)
      if (pPick != null && (pPick / 100) * odds > 1.05) {
        evBets++
        evStaked += 1
        if (isWin) evProfit += odds - 1
        else if (!isPush) evProfit -= 1
      }
      // Quarter-Kelly (0.25 × fraction, cap 2 % du bankroll) si stake archivé
      const kStake = kellyStake(rec.kellyStakePct, odds)
      if (kStake != null) {
        kellyBets++
        kellyStaked += kStake
        if (isWin) kellyProfit += kStake * (odds - 1)
        else if (!isPush) kellyProfit -= kStake
      }
    } else {
      roiExcluded++
      // Diagnostic (audit P3) : pourquoi ce pick est exclu du ROI ?
      const mkMiss = marketKey(rec.pick) || 'unknown'
      oddsMissingByMarket[mkMiss] = (oddsMissingByMarket[mkMiss] || 0) + 1
    }

    const pickProb = pickProbability(rec.pick, rec.probs) ?? rec.confidence
    if (pickProb != null) {
      const band = calibrationBands(pickProb)
      if (band) {
        if (!calib[band.band]) calib[band.band] = { count: 0, correct: 0 }
        calib[band.band].count++
        if (ok) calib[band.band].correct++
      }
    }

    const lg = rec.league || 'Unknown'
    if (!leagueMap[lg]) leagueMap[lg] = { count: 0, correct: 0 }
    leagueMap[lg].count++
    if (ok) leagueMap[lg].correct++

    // ── Décomposition par marché (1X2 / DC / OU) ──
    const mk = marketKey(rec.pick)
    if (mk) {
      if (!byMarket[mk])
        byMarket[mk] = {
          count: 0,
          correct: 0,
          sumOdds: 0,
          roiBets: 0,
          flatStaked: 0,
          flatProfit: 0,
          nOddsWinners: 0,
          sumOddsWinners: 0,
          nOddsLosers: 0,
          sumOddsLosers: 0,
        }
      byMarket[mk].count++
      if (ok === true) byMarket[mk].correct++
      const mOdds = pickOdds(rec.pick, rec.odds)
      if (mOdds != null) {
        const isPush = isOU(rec.pick) && rec.scoreHome + rec.scoreAway === parseFloat(rec.pick.slice(1))
        byMarket[mk].roiBets++
        byMarket[mk].sumOdds += mOdds
        byMarket[mk].flatStaked += 1
        if (ok === true) {
          byMarket[mk].flatProfit += mOdds - 1
          byMarket[mk].nOddsWinners++
          byMarket[mk].sumOddsWinners += mOdds
        } else if (!isPush) {
          byMarket[mk].flatProfit -= 1
          byMarket[mk].nOddsLosers++
          byMarket[mk].sumOddsLosers += mOdds
        }
      }
    }
  }

  // L'accuracy est calculée sur les matchs évalués hors push (traitement standard :
  // un push O/U est remboursé, ni gagné ni perdu).
  const denominator = Math.max(1, evaluated - pushCount)
  const accuracy = evaluated > 0 ? (correct / denominator) * 100 : null
  const accuracyPct = accuracy === null ? null : accuracy.toFixed(1) + '%'

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      from: options.from ?? null,
      to: options.to ?? null,
      marketFilter,
      sources: { matches: FT_STATUSES.join('|'), historical_matches: true },
    },
    empty: N === 0,
    summary: {
      total: N,
      evaluated,
      correct,
      pushCount,
      finishedCount,
      noPredictionCount,
      pendingCount,
      // Audit Prio 1 (2026-08-26) : performance isolée des picks low-data /
      // ZERO-DATA RESCUE. lowDataAccuracy exclut les push O/U du dénominateur
      // (même règle que l'accuracy générale). null si aucun pick low-data marqué.
      lowDataCount,
      lowDataCorrect,
      lowDataPush,
      lowDataAccuracy:
        lowDataCount > 0
          ? +(lowDataCorrect / Math.max(1, lowDataCount - lowDataPush)).toFixed(4)
          : null,
      // Audit A/B (2026-08-26) : accuracy par bracket de confiance. Chaque entrée
      // { count, correct, push, accuracy } ; accuracy exclut les push O/U du
      // dénominateur. Sert à comparer PROB_BOOSTS=on vs off sur le bracket 70-80%.
      byConfidenceBracket: Object.fromEntries(
        Object.entries(byConfidenceBracket).map(([k, v]) => [
          k,
          {
            count: v.count,
            correct: v.correct,
            push: v.push,
            accuracy: v.count > 0 ? +(v.correct / Math.max(1, v.count - v.push)).toFixed(4) : null,
          },
        ])
      ),
      accuracy: accuracy === null ? null : correct / denominator,
      accuracyPct,
      logLoss: logLossCount > 0 ? +(logLossSum / logLossCount).toFixed(4) : null,
      brierScore: brierCount > 0 ? +(brierSum / brierCount).toFixed(4) : null,
      // ROI live : baseline 1u plate + Quarter-Kelly (0.25, cap 2 %)
      roiBets,
      roiExcluded,
      staked: +flatStaked.toFixed(2),
      netProfit: +flatProfit.toFixed(2),
      roi: flatStaked > 0 ? +((flatProfit / flatStaked) * 100).toFixed(2) : null,
      // Audit P3 : cotes moyennes gagnants vs perdants (le cœur de l'analyse ROI)
      avgOddsWinners: nOddsWinners > 0 ? +(sumOddsWinners / nOddsWinners).toFixed(2) : null,
      avgOddsLosers: nOddsLosers > 0 ? +(sumOddsLosers / nOddsLosers).toFixed(2) : null,
      oddsMissingByMarket,
      // Audit P3 : vue alternative — seuls les picks à espérance modèle positive
      // (p × cote > 1.05) sont comptés comme pariables. Kelly volontairement
      // écarté tant que la calibration n'est pas validée sur n≥200 paris.
      roiEvFiltered: {
        bets: evBets,
        staked: +evStaked.toFixed(2),
        netProfit: +evProfit.toFixed(2),
        roi: evStaked > 0 ? +((evProfit / evStaked) * 100).toFixed(2) : null,
      },
      kellyBets,
      kellyStaked: +kellyStaked.toFixed(4),
      kellyNetProfit: +kellyProfit.toFixed(4),
      kellyRoi: kellyStaked > 0 ? +((kellyProfit / kellyStaked) * 100).toFixed(2) : null,
    },
    calibrationCurve: Object.entries(calib)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([band, d]) => ({
        band,
        count: d.count,
        correct: d.correct,
        accuracy: +((d.correct / d.count) * 100).toFixed(1),
      })),
    byLeague: Object.entries(leagueMap)
      .map(([league, d]) => ({
        league,
        total: d.count,
        correct: d.correct,
        accuracy: +((d.correct / d.count) * 100).toFixed(1),
      }))
      .sort((a, b) => b.total - a.total),
    byMarket: Object.entries(byMarket)
      .map(([market, d]) => ({
        market,
        total: d.count,
        correct: d.correct,
        accuracy: +((d.correct / Math.max(1, d.count)) * 100).toFixed(1),
        avgOdds: d.roiBets > 0 ? +((d.sumOdds / d.roiBets) * 1).toFixed(2) : null,
        avgOddsWinners:
          d.nOddsWinners > 0 ? +(d.sumOddsWinners / d.nOddsWinners).toFixed(2) : null,
        avgOddsLosers: d.nOddsLosers > 0 ? +(d.sumOddsLosers / d.nOddsLosers).toFixed(2) : null,
        roiBets: d.roiBets,
        flatRoi: d.flatStaked > 0 ? +((d.flatProfit / d.flatStaked) * 100).toFixed(2) : null,
      }))
      .sort((a, b) => b.total - a.total),
    excludedLabels: Object.entries(excludedLabels).map(([label, count]) => ({
      label,
        reason: `Label hors whitelist (valides: 1, X, 2, 1X, X2, 12, O/U+seuil, BTTS YES/NO) — exclu du calcul d'accuracy`,
      count,
    })),
  }
}

module.exports = {
  computeAccuracy,
  normalizeLabel,
  marketKey,
  isCorrect,
  pickProbability,
  pickOdds,
  recordsFromHistorical,
}
