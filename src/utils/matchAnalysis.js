// Analyse pure d'un match — source de vérité partagée entre la liste du
// Dashboard et la modale de détail (UltimateMatchCenter).
// Calcule verdicts 1/X/2, BTTS, O/U, corners, handicap + honesty gate.

export const FINISHED_STATUSES = new Set([
  'finished',
  'ft',
  'ended',
  'closed',
  'played',
  'aet',
  'pen',
  'ap',
  'match_finished',
  'awarded',
  'walkover',
])

// Statuts "déjà commencé / en direct" : jamais listables comme matchs à venir.
export const LIVE_OR_STARTED_STATUSES = new Set([
  'live',
  'inprogress',
  'in_progress',
  'in play',
  'in_play',
  'playing',
  '1st_half',
  'first_half',
  '2nd_half',
  'second_half',
  'ht',
  'half_time',
  'halftime',
  'break',
  'extra_time',
  'et',
  'awaiting_extra_time',
  'awaiting_penalties',
  'abandoned',
  'suspended',
  'interrupted',
  'delayed',
])

// Reporté/annulé/forfait : à exclure de toute liste.
export const DEAD_STATUSES = new Set(['postponed', 'canceled', 'cancelled'])

// Statuts "pas encore commencé" (minuscules) pour l'heuristique score-présent.
// NB : statut vide ≠ "à venir" — un match sans statut mais avec un score est
// considéré joué (comportement historique conservé).
const NOT_STARTED_SET = new Set([
  'scheduled',
  'upcoming',
  'not_started',
  'notstarted',
  'ns',
  'prematch',
  'fixture',
  'timed',
])

// Un match est considéré joué si son statut est terminal OU si un score
// complet est présent alors que le statut n'indique pas "à venir".
export const isFinishedMatch = (m) => {
  const s = String(m?.status || '').toLowerCase().trim()
  if (FINISHED_STATUSES.has(s)) return true
  const sh = parseInt(m?.scoreHome, 10)
  const sa = parseInt(m?.scoreAway, 10)
  if (!isNaN(sh) && !isNaN(sa) && !NOT_STARTED_SET.has(s)) return true
  // minute affichée > 0 (ex: 63, "45+") ⇒ le match a démarré (donc plus "à venir")
  const minNum = typeof m?.minute === 'number' ? m.minute : parseInt(String(m?.minute ?? ''), 10)
  if (Number.isFinite(minNum) && minNum > 0) return true
  return false
}

const normalizePct = (v) => {
  const n = Number(v || 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1 ? Math.round(n) : Math.round(n * 100)
}

export function analyzeMatch(m) {
  const out = {
    league: m?.league || m?.tournament_name || '',
    homeTeam: m?.homeTeam || '',
    awayTeam: m?.awayTeam || '',
    finished: false,
    score: null,
    btts: { label: '--', pct: 0, verdict: '' },
    ou: { label: '--', pct: 0, direction: '' },
    corners: { label: '--', line: null, pct: 0, verdict: '' },
    handicap: { label: '--', pct: 0 },
    winner: { pick: '--', prob: 0, label: '--', solid: false },
    probs: { home: 0, draw: 0, away: 0 },
    honesty: { mode: 'normal', insufficient: false, modelOnly: false, realModelSignal: false },
    odds: { home: 0, draw: 0, away: 0 },
    hasRealOdds: false,
  }
  if (!m) return out

  if (isFinishedMatch(m)) {
    out.finished = true
    const sh = parseInt(m.scoreHome) || 0
    const sa = parseInt(m.scoreAway) || 0
    out.score =
      m.scoreHome != null && m.scoreAway != null ? `${m.scoreHome}-${m.scoreAway}` : '--'
    const result = sh > sa ? '1' : sh < sa ? '2' : 'X'
    out.winner = { pick: result, prob: 0, label: result, solid: false }
    return out
  }

  const enriched = m.enriched || {}
  const quant = m.quant || enriched?.quant || {}
  const markets = quant.markets || {}

  const hasRealOdds =
    parseFloat(m.odds_home) > 0 && parseFloat(m.odds_draw) > 0 && parseFloat(m.odds_away) > 0
  const hasOuOdds = parseFloat(m.odds_over25) > 0 || parseFloat(m.odds_under25) > 0
  const hasBttsOdds = parseFloat(m.odds_btts_yes) > 0 || parseFloat(m.odds_btts_no) > 0

  const isInsufficient =
    (m.insufficient_data === 1 || m.sufficient === false || quant.market_odds === null) &&
    !hasRealOdds
  out.honesty.insufficient = isInsufficient

  // ── BTTS ──
  const bttsMkt = markets.btts
  let bttsYesPct = 0
  if (bttsMkt && (bttsMkt.YES || bttsMkt.NO)) {
    const yes = normalizePct(bttsMkt.YES?.prob)
    const no = normalizePct(bttsMkt.NO?.prob)
    bttsYesPct = yes
    out.btts =
      yes >= no
        ? { label: `OUI ${yes}%`, pct: yes, verdict: 'OUI' }
        : { label: `NON ${no}%`, pct: no, verdict: 'NON' }
  } else {
    const bttsPct = normalizePct(quant.probs?.btts || m.btts_prob || enriched?.btts_prob || 0)
    bttsYesPct = bttsPct
    out.btts =
      bttsPct > 0
        ? bttsPct >= 50
          ? { label: `OUI ${bttsPct}%`, pct: bttsPct, verdict: 'OUI' }
          : { label: `NON ${100 - bttsPct}%`, pct: 100 - bttsPct, verdict: 'NON' }
        : { label: '--', pct: 0, verdict: '' }
  }

  // ── O/U : les 4 lignes (O1.5 / O2.5 / O3.5 / O4.5) ──
  // Chaque ligne = proba Over (P(total buts > line)), direction O si > 50 sinon U.
  const ouMkt = markets.over_under || {}
  const fallbackOu25 = normalizePct(quant.probs?.over25 || m.ou_25_prob || enriched?.ou_25_prob || 0)
  const buildOuLine = (line) => {
    const o = normalizePct(ouMkt[`O${line}`]?.prob)
    const u = normalizePct(ouMkt[`U${line}`]?.prob)
    const overPct = o > 0 ? o : u > 0 ? 100 - u : line === 2.5 ? fallbackOu25 : 0
    return { line, overPct, dir: overPct > 50 ? 'OVER' : 'UNDER', pct: overPct > 50 ? overPct : 100 - overPct }
  }
  const ouLines = [1.5, 2.5, 3.5, 4.5].map(buildOuLine).filter((l) => l.overPct > 0)
  // Ligne la plus fiable (la plus éloignée du 50/50) pour le chip compact.
  const bestOu =
    ouLines.length > 0
      ? ouLines.reduce((a, b) => (Math.abs(b.overPct - 50) > Math.abs(a.overPct - 50) ? b : a))
      : { line: 2.5, overPct: fallbackOu25, dir: fallbackOu25 > 50 ? 'OVER' : 'UNDER', pct: fallbackOu25 > 50 ? fallbackOu25 : 100 - fallbackOu25 }
  out.ou = {
    label: bestOu.overPct > 0 ? `${bestOu.dir} ${bestOu.line.toFixed(1)} ${bestOu.pct}%` : '--',
    pct: bestOu.pct,
    direction: bestOu.dir,
    lines: ouLines,
  }

  // ── Probabilités 1/X/2 ──
  // Source la plus forte : cotes réelles → probas dé-vigées (P = 1/odds ÷ Σ 1/odds).
  // Sinon : blend 50/50 entre modèle (home/draw/away_win_probability) et marchés
  // (quant.markets.match_result) quand les deux existent (réduction de variance).
  const mr = markets.match_result || {}
  const mktH = mr['1'] ? normalizePct(mr['1'].prob) : 0
  const mktD = mr['X'] ? normalizePct(mr['X'].prob) : 0
  const mktA = mr['2'] ? normalizePct(mr['2'].prob) : 0
  const modelH = normalizePct(m.home_win_probability || enriched?.home_win_probability || 0)
  const modelD = normalizePct(m.draw_probability || enriched?.draw_probability || 0)
  const modelA = normalizePct(m.away_win_probability || enriched?.away_win_probability || 0)

  let hPct = 0
  let dPct = 0
  let aPct = 0
  if (hasRealOdds) {
    const ih = 1 / parseFloat(m.odds_home)
    const id = 1 / parseFloat(m.odds_draw)
    const ia = 1 / parseFloat(m.odds_away)
    const sumInv = ih + id + ia
    if (sumInv > 0) {
      hPct = Math.round((ih / sumInv) * 100)
      dPct = Math.round((id / sumInv) * 100)
      aPct = Math.round((ia / sumInv) * 100)
    }
  } else {
    const hasModel = modelH + modelD + modelA > 0
    const hasMkt = mktH + mktD + mktA > 0
    if (hasModel && hasMkt) {
      hPct = Math.round((modelH + mktH) / 2)
      dPct = Math.round((modelD + mktD) / 2)
      aPct = Math.round((modelA + mktA) / 2)
    } else if (hasModel) {
      hPct = modelH
      dPct = modelD
      aPct = modelA
    } else if (hasMkt) {
      hPct = mktH
      dPct = mktD
      aPct = mktA
    }
  }
  out.probs = { home: hPct, draw: dPct, away: aPct }
  const hasProbs = hPct + dPct + aPct > 0

  // Cotes implicites du modèle (FAIR ODDS) — calculées depuis les probas 1X2
  // du modèle quand AUCUNE cote bookmaker réelle n'est dispo. Clarifie l'état
  // « sans cotes » en fournissant une référence (overround 5%) clairement
  // distincte des vraies cotes (pas d'EV calculable sans marché réel).
  let impliedOdds = null
  if (!hasRealOdds && hasProbs) {
    const total = hPct + dPct + aPct
    if (total > 0) {
      const margin = 1.05
      const ih = hPct / total / margin
      const id = dPct / total / margin
      const ia = aPct / total / margin
      if (ih > 0 && id > 0 && ia > 0) {
        impliedOdds = {
          home: +(1 / ih).toFixed(2),
          draw: +(1 / id).toFixed(2),
          away: +(1 / ia).toFixed(2),
        }
      }
    }
  }
  out.impliedOdds = impliedOdds
  out.oddsSource = hasRealOdds ? 'real' : impliedOdds ? 'model' : 'none'

  // ── GAGNANT : base = vrai 1/X/2 toujours + double chance en secondaire ──
  let winner = '?'
  let winnerProb = null
  let winnerDc = null
  let winnerDcProb = null
  const bestDc = () => {
    const combos = [
      { k: '1X', p: hPct + dPct },
      { k: '12', p: hPct + aPct },
      { k: 'X2', p: dPct + aPct },
    ].sort((a, b) => b.p - a.p)
    return combos[0]
  }
  if (hasProbs) {
    const maxP = Math.max(hPct, dPct, aPct)
    winner = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
    winnerProb = maxP
    const dc = bestDc()
    winnerDc = dc.k
    winnerDcProb = dc.p
  }

  // ── CORNERS : nombre exact de corners attendu ──
  const cornersVerdict = m.cornersVerdict || m.enriched?.cornersVerdict || null
  let cornersLabel = '--'
  if (cornersVerdict && typeof cornersVerdict.expectedTotal === 'number') {
    const expectedTotal = Number(cornersVerdict.expectedTotal)
    const exact = Math.round(expectedTotal)
    const line = cornersVerdict.line ?? 10.5
    const over = Number(cornersVerdict.over ?? 0)
    const under = Number(cornersVerdict.under ?? 0)
    const verdict = over >= under ? 'O' : 'U'
    const pct = Math.round(Math.max(over, under) * 100)
    cornersLabel = `✚ ${exact}`
    out.corners = { label: cornersLabel, exact, expectedTotal, line, pct, verdict, over, under }
  }

  // ── BUT 1ER MT (OUI/NON) : remplace l'ancien « handicap » ──
  const fhMkt = markets.first_half || {}
  let htGoalPct = 0
  if (fhMkt['O0.5'] && fhMkt['O0.5'].prob) {
    htGoalPct = normalizePct(fhMkt['O0.5'].prob)
  } else {
    htGoalPct = normalizePct(quant.probs?.ht_goal || enriched?.ht_goal || 0)
  }
  if (!htGoalPct) {
    // Fallback historique (estimation O/U + BTTS) quand aucun signal 1er MT.
    htGoalPct = Math.min(89, Math.round((out.ou.pct + bttsYesPct) / 2 + 5))
  }
  out.htGoal =
    htGoalPct >= 50
      ? { label: `OUI ${htGoalPct}%`, pct: htGoalPct, verdict: 'OUI' }
      : { label: `NON ${100 - htGoalPct}%`, pct: 100 - htGoalPct, verdict: 'NON' }

  // ── HONESTY GATE ──
  const rawHPct = normalizePct(m.home_win_probability || enriched?.home_win_probability || 0)
  const rawAPct = normalizePct(m.away_win_probability || enriched?.away_win_probability || 0)
  const rawDPct = normalizePct(m.draw_probability || enriched?.draw_probability || 0)
  const modelMax = Math.max(rawHPct, rawAPct, rawDPct)
  const modelMin = Math.min(rawHPct, rawAPct, rawDPct)
  const hasRealModelSignal =
    isInsufficient &&
    modelMax >= 50 &&
    modelMax - modelMin >= 20 &&
    (hPct + aPct > 0 || rawHPct > 0)
  const modelWinner =
    rawHPct >= rawAPct && rawHPct >= rawDPct ? '1' : rawAPct >= rawDPct ? '2' : 'X'
  const modelWinnerProb = modelWinner === '1' ? rawHPct : modelWinner === '2' ? rawAPct : rawDPct

  const isModelOnlyPick =
    !isInsufficient && !hasRealOdds && String(m.prediction || '').trim() !== ''
  out.hasRealOdds = hasRealOdds
  out.hasOuOdds = hasOuOdds
  out.hasBttsOdds = hasBttsOdds
  out.odds = {
    home: parseFloat(m.odds_home) || 0,
    draw: parseFloat(m.odds_draw) || 0,
    away: parseFloat(m.odds_away) || 0,
  }

  // Pick final selon le mode d'honnêteté (base 1/X/2 + DC secondaire)
  let mode = 'normal'
  let pick = winner
  let pickProb = winnerProb
  let pickLabel = winnerProb ? `${winner} ${Math.round(winnerProb)}%` : winner
  let pickDc = winnerDc
  let pickDcProb = winnerDcProb
  if (isModelOnlyPick) {
    mode = 'modelOnly'
  } else if (hasRealModelSignal) {
    mode = 'modelSignal'
    pick = modelWinner
    pickProb = modelWinnerProb
    pickLabel = `${modelWinner} ${Math.round(modelWinnerProb)}%`
    const rawCombos = [
      { k: '1X', p: rawHPct + rawDPct },
      { k: '12', p: rawHPct + rawAPct },
      { k: 'X2', p: rawDPct + rawAPct },
    ].sort((a, b) => b.p - a.p)
    pickDc = rawCombos[0].k
    pickDcProb = rawCombos[0].p
  } else if (isInsufficient) {
    mode = 'insufficient'
    const totalP = hPct + dPct + aPct
    if (totalP > 0) {
      const maxP = Math.max(hPct, dPct, aPct)
      pick = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
      pickProb = maxP
      const combos = [
        { k: '1X', p: hPct + dPct },
        { k: '12', p: hPct + aPct },
        { k: 'X2', p: dPct + aPct },
      ].sort((a, b) => b.p - a.p)
      pickDc = combos[0].k
      pickDcProb = combos[0].p
    }
    pickLabel = pickProb > 0 ? `${pick} ${Math.round(pickProb)}%` : '--'
  }
  out.honesty.mode = mode
  out.honesty.modelOnly = isModelOnlyPick
  out.honesty.realModelSignal = hasRealModelSignal
  out.winner = {
    pick,
    prob: pickProb,
    label: pickLabel,
    solid: typeof pickProb === 'number' && pickProb >= 65,
  }
  out.winnerDc =
    pickDc && pickDcProb > 0
      ? { pick: pickDc, prob: pickDcProb, label: `${pickDc} ${Math.round(pickDcProb)}%` }
      : null

  return out
}

// Construit la ligne "raw" consommée par MatchCard (liste du Dashboard).
// Toujours cohérent avec analyzeMatch → la liste et la modale restent alignées.
export function computeRawLines(m) {
  if (!m) return []
  const a = analyzeMatch(m)
  if (a.finished) {
    return [
      a.league,
      a.homeTeam,
      a.awayTeam,
      '--',
      '--',
      a.winner.pick,
      a.score || '--',
      '--',
      a.score || '--',
      '0',
      '--',
      '--',
      '--',
    ]
  }
  const mode = a.honesty.mode
  const leagueLabel =
    mode === 'modelOnly'
? `${a.league} 🔮 est. modèle`
        : mode === 'modelSignal'
          ? `${a.league} 🔮 signal modèle`
        : mode === 'insufficient'
          ? `${a.league} 🔮 est. modèle`
          : a.league
  const winnerCell =
    !a.winner.pick || a.winner.pick === '?' ? '--' : a.winner.label
  const winnerDcCell = a.winnerDc ? a.winnerDc.label : '--'
  const ouCell = !a.hasOuOdds ? (a.ou.pct > 0 ? a.ou.label : '--') : a.ou.label
  const ouLinesCell =
    a.ou.lines && a.ou.lines.length > 0
      ? a.ou.lines.map((l) => `${l.line}:${l.overPct}`).join('|')
      : '--'
  const htGoalCell =
    mode === 'insufficient'
      ? a.probs.home + a.probs.draw + a.probs.away > 0
        ? a.htGoal.label
        : '--'
      : a.htGoal.label
  const bttsCell = !a.hasBttsOdds ? (a.btts.pct > 0 ? a.btts.label : '--') : a.btts.label
  const cornersCell =
    mode === 'insufficient' ? (a.corners.pct > 0 ? a.corners.label : '--') : a.corners.label
  const cornersExactCell = a.corners.exact ? String(a.corners.exact) : '--'
  return [
    leagueLabel,
    a.homeTeam,
    a.awayTeam,
    bttsCell,
    ouCell,
    winnerCell,
    htGoalCell,
    cornersCell,
    null,
    a.winner.solid ? '1' : '0',
    winnerDcCell,
    ouLinesCell,
    cornersExactCell,
  ]
}
