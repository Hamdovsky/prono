/**
 * marketAnalysisService.js — Unified market analysis engine
 * Converts Poisson xG model → O/U, BTTS, DC, HT/FT, Corners, Cards
 */
const logger = require('../core/logger')

/* ─── Poisson Base ─── */
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0
  let p = Math.exp(-lambda)
  for (let i = 1; i <= k; i++) p *= lambda / i
  return p
}

function poissonRandom(lambda) {
  const L = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= Math.random()
  } while (p > L)
  return k - 1
}

function probToOdds(prob) {
  if (!prob || prob <= 0) return null
  return +(1 / prob).toFixed(2)
}

/* ─── 1. Over / Under ─── */
function overUnder(xgH, xgA, lines = [2.5, 3.5, 1.5, 4.5, 0.5]) {
  const maxGoals = 12
  const totalProb = Array(maxGoals + 1).fill(0)
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      totalProb[h + a] += poissonProb(xgH, h) * poissonProb(xgA, a)
    }
  }

  return lines.map((line) => {
    let over = 0
    for (let g = Math.floor(line) + 1; g <= maxGoals; g++) over += totalProb[g]
    const under = 1 - over
    const fairOver = probToOdds(over)
    const fairUnder = probToOdds(under)
    return {
      line,
      overProb: +over.toFixed(4),
      underProb: +under.toFixed(4),
      fairOver,
      fairUnder,
    }
  })
}

/* ─── 2. BTTS ─── */
function btts(xgH, xgA, maxGoals = 6) {
  let bothScore = 0
  for (let h = 1; h <= maxGoals; h++) {
    for (let a = 1; a <= maxGoals; a++) {
      bothScore += poissonProb(xgH, h) * poissonProb(xgA, a)
    }
  }
  const noBTTS = 1 - bothScore
  return {
    bttsProb: +bothScore.toFixed(4),
    noBttsProb: +noBTTS.toFixed(4),
    fairBttsOdds: probToOdds(bothScore),
    fairNoBttsOdds: probToOdds(noBTTS),
  }
}

/* ─── 3. Double Chance ─── */
function doubleChance(fairProbH, fairProbD, fairProbA) {
  return {
    '1X': {
      outcome: '1X',
      prob: +(fairProbH + fairProbD).toFixed(4),
      fairOdds: probToOdds(fairProbH + fairProbD),
    },
    12: {
      outcome: '12',
      prob: +(fairProbH + fairProbA).toFixed(4),
      fairOdds: probToOdds(fairProbH + fairProbA),
    },
    X2: {
      outcome: 'X2',
      prob: +(fairProbD + fairProbA).toFixed(4),
      fairOdds: probToOdds(fairProbD + fairProbA),
    },
  }
}

/* ─── 4. HT/FT ─── */
function htFt(xgH, xgA, maxGoals = 5) {
  const FIRST_HALF_FACTOR = 0.45
  const hg1 = xgH * FIRST_HALF_FACTOR
  const ag1 = xgA * FIRST_HALF_FACTOR
  const hg2 = xgH - hg1
  const ag2 = xgA - ag1

  /* Precompute half-time probs */
  function halfProbs(hg, ag) {
    const res = { H: 0, D: 0, A: 0 }
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) {
        const p = poissonProb(hg, h) * poissonProb(ag, a)
        if (h > a) res.H += p
        else if (h === a) res.D += p
        else res.A += p
      }
    }
    return res
  }

  const ht = halfProbs(hg1, ag1)
  const ft = halfProbs(hg2, ag2)

  const results = {}
  for (const htRes of ['H', 'D', 'A']) {
    for (const ftRes of ['H', 'D', 'A']) {
      const key = `${htRes}/${ftRes}`
      results[key] = {
        outcome: key,
        prob: +(ht[htRes] * ft[ftRes]).toFixed(4),
        fairOdds: probToOdds(ht[htRes] * ft[ftRes]),
      }
    }
  }

  return {
    halfTime: ht,
    fullTime: ft,
    combinations: results,
    topPick: Object.entries(results)
      .sort((a, b) => b[1].prob - a[1].prob)
      .slice(0, 3)
      .map(([k, v]) => v),
  }
}

/* ─── 5. Corners ─── */
/**
 * Fast deterministic corners verdict (no Monte-Carlo).
 * Poisson with lambda = expected total corners (2.8 per xG), summed like overUnder.
 * Returns { expectedTotal, line, over, under, fairOver, fairUnder, label }.
 */
function cornersVerdict(xgH, xgA, line = 10.5) {
  const CORNERS_PER_XG = 2.8
  const expectedTotal = Math.max(1, (xgH + xgA) * CORNERS_PER_XG)
  const floorLine = Math.floor(line)
  let over = 0
  for (let k = floorLine + 1; k <= 40; k++) over += poissonProb(expectedTotal, k)
  const overProb = +over.toFixed(4)
  const underProb = +(1 - overProb).toFixed(4)
  const verdict = overProb >= underProb ? 'O' : 'U'
  const pct = Math.round(Math.max(overProb, underProb) * 100)
  return {
    expectedTotal: +expectedTotal.toFixed(1),
    line,
    over: overProb,
    under: underProb,
    fairOver: probToOdds(overProb),
    fairUnder: probToOdds(underProb),
    label: `${verdict} ${line.toFixed(1)} ${pct}%`,
  }
}

function corners(xgH, xgA) {
  /* Empirical: ~10.5 corners per PL match, ~2.8 corners per xG */
  const CORNERS_PER_XG = 2.8
  const totalXg = xgH + xgA
  const expectedCorners = totalXg * CORNERS_PER_XG

  const lines = [9.5, 10.5, 11.5, 12.5, 8.5]
  const sims = 20000
  const results = []

  for (const line of lines) {
    let over = 0
    for (let i = 0; i < sims; i++) {
      /* Poisson-ish for corners */
      const c = Math.round(expectedCorners + (Math.random() - 0.5) * 4)
      if (c > line) over++
    }
    const overProb = over / sims
    results.push({
      line,
      expectedTotal: +expectedCorners.toFixed(1),
      overProb: +overProb.toFixed(3),
      underProb: +(1 - overProb).toFixed(3),
      fairOver: probToOdds(overProb),
      fairUnder: probToOdds(1 - overProb),
    })
  }

  return results
}

/* ─── 6. Cards ─── */
function cards(xgH, xgA, league) {
  /* Cards per xG by league (empirical) */
  const CARDS_RATES = {
    PL: 0.42,
    'Premier League': 0.42,
    'La Liga': 0.55,
    Liga: 0.55,
    'Serie A': 0.5,
    'Ligue 1': 0.48,
    Bundesliga: 0.4,
  }
  const rate = CARDS_RATES[league] || 0.45
  const totalCards = (xgH + xgA) * rate * 90 /* per 90 */
  const sims = 20000

  const lines = [4.5, 5.5, 6.5, 3.5]
  const results = []

  for (const line of lines) {
    let over = 0
    for (let i = 0; i < sims; i++) {
      const cards = Math.round(totalCards + (Math.random() - 0.5) * 3)
      if (cards > line) over++
    }
    results.push({
      line,
      expectedTotal: +totalCards.toFixed(1),
      overProb: +(over / sims).toFixed(3),
      underProb: +((sims - over) / sims).toFixed(3),
      fairOver: probToOdds(over / sims),
      fairUnder: probToOdds(1 - over / sims),
    })
  }

  return results
}

/* ─── Player Props (simplified) ─── */
function playerProps(xgH, xgA, homePlayers, awayPlayers) {
  if (!homePlayers?.length && !awayPlayers?.length) return []
  const props = []

  /* For each key attacker, estimate anytime scorer prob based on xG share */
  for (const player of [...(homePlayers || []), ...(awayPlayers || [])]) {
    if (!player || !player.name) continue
    if (
      !['Forward', 'Striker', 'Attacking Midfield', 'Midfielder', 'Winger'].includes(
        player.position || ''
      )
    )
      continue
    const teamXg = player.team === 'home' ? xgH : xgA
    const xgShare = player.xGPerGame || player.xgPerMatch || 0.15
    const goalProb = 1 - Math.exp(-xgShare)
    const fairOdds = probToOdds(goalProb)

    props.push({
      player: player.name,
      team: player.team || 'unknown',
      position: player.position || 'N/A',
      goalProb: +goalProb.toFixed(3),
      fairOdds,
      marketAvg: player.marketOdds || null,
    })
  }

  return props.sort((a, b) => b.goalProb - a.goalProb).slice(0, 10)
}

/* ─── Public API ─── */

// Complète les lignes O/U manquantes (O1.5 / U1.5 / O4.5 / U4.5) dans
// quant.markets.over_under d'un match, via le Poisson du StatisticalEngine.
// Idempotent : ne remplace jamais une ligne déjà présente.
function ensureOuLines(markets, xgH, xgA) {
  if (!markets || !markets.over_under) return markets
  const ou = markets.over_under
  if (ou['O1.5'] && ou['U1.5'] && ou['O4.5'] && ou['U4.5']) return markets
  try {
    const StatisticalEngine = require('../core/services/StatisticalEngine')
    const p = StatisticalEngine.calculatePoissonProbs(xgH || 1.2, xgA || 1.0, {})
    const patch = {
      'O1.5': { prob: p.over15, odds: 1.4 },
      'U1.5': { prob: p.under15, odds: 2.6 },
      'O4.5': { prob: p.over45, odds: 6.0 },
      'U4.5': { prob: p.under45, odds: 1.12 },
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!ou[k]) ou[k] = { ...v, ev: v.prob * (v.odds || 2.0) - 1 }
    }
  } catch (e) {
    logger.debug(`[MARKET] ensureOuLines skipped: ${e.message}`)
  }
  return markets
}

function analyzeAll(match, model) {
  const xgH = model?.xgH ?? model?.homeXG ?? 1.2
  const xgA = model?.xgA ?? model?.awayXG ?? 1.0
  const fairH = model?.h ?? 0.33
  const fairD = model?.d ?? model?.draw ?? 0.33
  const fairA = model?.a ?? 0.33

  return {
    overUnder: overUnder(xgH, xgA),
    btts: btts(xgH, xgA),
    doubleChance: doubleChance(fairH, fairD, fairA),
    htFt: htFt(xgH, xgA),
    corners: corners(xgH, xgA),
    cards: cards(xgH, xgA, match?.league),
    playerProps: playerProps(xgH, xgA, model?.homePlayers, model?.awayPlayers),
  }
}

module.exports = {
  analyzeAll,
  ensureOuLines,
  overUnder,
  btts,
  doubleChance,
  htFt,
  corners,
  cornersVerdict,
  cards,
  playerProps,
}
