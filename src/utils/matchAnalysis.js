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
])

export const isFinishedMatch = (m) => {
  const s = String(m?.status || '').toLowerCase()
  if (FINISHED_STATUSES.has(s)) return true
  const sh = parseInt(m?.scoreHome)
  const sa = parseInt(m?.scoreAway)
  if (!isNaN(sh) && !isNaN(sa) && s !== 'scheduled' && s !== 'NOT_STARTED' && s !== 'NS')
    return true
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

  // ── O/U 2.5 → proba Over ──
  const ouMkt = markets.over_under
  let ouPct = normalizePct(quant.probs?.over25 || m.ou_25_prob || enriched?.ou_25_prob || 0)
  if (ouMkt && (ouMkt['O2.5'] || ouMkt['U2.5'])) {
    const o25 = normalizePct(ouMkt['O2.5']?.prob)
    const u25 = normalizePct(ouMkt['U2.5']?.prob)
    ouPct = o25 > 0 ? o25 : u25 > 0 ? 100 - u25 : ouPct
  }
  out.ou = {
    label: ouPct > 0 ? `${ouPct}%` : '--',
    pct: ouPct,
    direction: ouPct > 0 ? (ouPct > 50 ? 'OVER' : 'UNDER') : '',
  }

  // ── Probabilités 1/X/2 ──
  // Source la plus forte : cotes réelles → probas dé-vigées (P = 1/odds ÷ Σ 1/odds).
  // Sinon : blend 50/50 entre modèle (home/draw/away_win_probability) et marchés
  // (quant.markets.match_result) quand les deux existent (réduction de variance).
  const mr = markets.match_result || {}
  const dc = markets.double_chance || {}
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

  // ── GAGNANT : toujours un vrai 1/X/2 ou une double chance ──
  let winner = '?'
  let winnerProb = null
  if (hasProbs) {
    const maxP = Math.max(hPct, dPct, aPct)
    if (maxP >= 65) {
      winner = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
      winnerProb = maxP
    } else {
      const combos = [
        { k: '1X', p: hPct + dPct },
        { k: '12', p: hPct + aPct },
        { k: 'X2', p: dPct + aPct },
      ].sort((a, b) => b.p - a.p)
      winner = combos[0].k
      winnerProb = combos[0].p
    }
  }
  const solidGagnant =
    ['1', '2'].includes(String(winner)) && typeof winnerProb === 'number' && winnerProb >= 65

  // ── CORNERS ──
  const cornersVerdict = m.cornersVerdict || m.enriched?.cornersVerdict || null
  let cornersLabel = '--'
  if (cornersVerdict && typeof cornersVerdict.expectedTotal === 'number') {
    const line = cornersVerdict.line ?? 10.5
    const over = Number(cornersVerdict.over ?? 0)
    const under = Number(cornersVerdict.under ?? 0)
    const verdict = over >= under ? 'O' : 'U'
    const pct = Math.round(Math.max(over, under) * 100)
    cornersLabel = `${verdict} ${line.toFixed(1)} ${pct}%`
    out.corners = { label: cornersLabel, line, pct, verdict }
  }

  // ── HANDICAP (indice de score / score attendu) ──
  const htPct = Math.min(89, Math.round((ouPct + bttsYesPct) / 2 + 5))
  out.handicap = { label: `${htPct}%`, pct: htPct }

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

  // Pick final selon le mode d'honnêteté
  let mode = 'normal'
  let pick = winner
  let pickProb = winnerProb
  let pickLabel = winnerProb ? `${winner} ${Math.round(winnerProb)}%` : winner
  if (isModelOnlyPick) {
    mode = 'modelOnly'
  } else if (hasRealModelSignal) {
    mode = 'modelSignal'
    pick = modelWinner
    pickProb = modelWinnerProb
    pickLabel = `${modelWinner} ${Math.round(modelWinnerProb)}%`
  } else if (isInsufficient) {
    mode = 'insufficient'
    const totalP = hPct + dPct + aPct
    let statWinner = '--'
    let statWinnerProb = 0
    if (totalP > 0) {
      const maxP = Math.max(hPct, dPct, aPct)
      if (maxP >= 65) {
        statWinner = maxP === hPct ? '1' : maxP === aPct ? '2' : 'X'
        statWinnerProb = maxP
      } else {
        const combos = [
          { k: '1X', p: hPct + dPct },
          { k: '12', p: hPct + aPct },
          { k: 'X2', p: dPct + aPct },
        ].sort((a, b) => b.p - a.p)
        statWinner = combos[0].k
        statWinnerProb = combos[0].p
      }
    }
    pick = statWinner
    pickProb = statWinnerProb
    pickLabel = statWinnerProb > 0 ? `${statWinner} ${Math.round(statWinnerProb)}%` : '--'
  }
  out.honesty.mode = mode
  out.honesty.modelOnly = isModelOnlyPick
  out.honesty.realModelSignal = hasRealModelSignal
  out.winner = { pick, prob: pickProb, label: pickLabel, solid: solidGagnant }

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
    ]
  }
  const mode = a.honesty.mode
  const leagueLabel =
    mode === 'modelOnly'
? `${a.league} 🔮 sans cotes (pas d'EV)`
        : mode === 'modelSignal'
          ? `${a.league} 🔮 signal`
        : mode === 'insufficient'
          ? `${a.league} 🔮 estimation sans cotes`
          : a.league
  const winnerCell =
    !a.winner.pick || a.winner.pick === '?' ? '--' : a.winner.label
  const ouCell = !a.hasOuOdds ? (a.ou.pct > 0 ? a.ou.label : '--') : a.ou.label
  const hcCell =
    mode === 'insufficient'
      ? a.probs.home + a.probs.draw + a.probs.away > 0
        ? a.handicap.label
        : '--'
      : a.handicap.label
  const bttsCell = !a.hasBttsOdds ? (a.btts.pct > 0 ? a.btts.label : '--') : a.btts.label
  const cornersCell =
    mode === 'insufficient' ? (a.corners.pct > 0 ? a.corners.label : '--') : a.corners.label
  return [
    leagueLabel,
    a.homeTeam,
    a.awayTeam,
    bttsCell,
    ouCell,
    winnerCell,
    hcCell,
    cornersCell,
    null,
    a.winner.solid ? '1' : '0',
  ]
}
