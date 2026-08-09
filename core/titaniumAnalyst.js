const StatisticalEngine = require('./services/StatisticalEngine')

const WEIGHTS = [1.0, 0.8, 0.6, 0.4, 0.2]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const toPct = (v) => Math.round(v * 1000) / 10

function confidenceLabel(prob) {
  if (prob >= 0.7) return 'elevee'
  if (prob >= 0.55) return 'moyenne'
  return 'faible'
}

function weightedFormScore(forme) {
  if (!Array.isArray(forme) || forme.length === 0) return null
  const recent = forme.slice(0, 5)
  let totalW = 0
  let weighted = 0
  recent.forEach((m, i) => {
    const w = WEIGHTS[i] ?? 0.2
    const r = (m.resultat || '').toUpperCase()
    let pts = 0
    if (r === 'V') pts = 3
    else if (r === 'N') pts = 1
    totalW += w
    weighted += w * pts
  })
  return totalW > 0 ? weighted / totalW : null
}

function formSummary(forme) {
  const recent = (Array.isArray(forme) ? forme : []).slice(0, 5)
  if (recent.length === 0) return 'Forme inconnue (donnees manquantes)'
  const wins = recent.filter((m) => (m.resultat || '').toUpperCase() === 'V').length
  const draws = recent.filter((m) => (m.resultat || '').toUpperCase() === 'N').length
  const losses = recent.filter((m) => (m.resultat || '').toUpperCase() === 'D').length
  const pts = weightedFormScore(recent)
  const ptsStr = pts !== null ? `, ${pts.toFixed(2)} pts/match pondere` : ''
  return `${wins}V ${draws}N ${losses}D sur ${recent.length}${ptsStr}`
}

function parseXg(stats, side) {
  const s = stats || {}
  const marked =
    side === 'h' ? s.buts_marques_dom || s.buts_marques : s.buts_marques_ext || s.buts_marques
  const xg = s.xg || 0
  if (xg > 0) return xg
  const goals = parseFloat(marked) || 0
  return goals > 0 ? goals : 0
}

function xgFromStats(statsA, statsB) {
  const xgAttA = parseXg(statsA, 'h') || 1.25
  const xgAttB = parseXg(statsB, 'a') || 1.15
  const xgDefA = parseFloat(statsA?.buts_encaisses_dom) || 0
  const xgDefB = parseFloat(statsB?.buts_encaisses_ext) || 0
  const defA = xgDefA > 0 ? xgDefA : 1.3
  const defB = xgDefB > 0 ? xgDefB : 1.3
  return {
    h: clamp((xgAttA + defB) / 2, 0.4, 3.5),
    a: clamp((xgAttB + defA) / 2, 0.4, 3.5),
  }
}

function absenceModifier(absents) {
  if (!Array.isArray(absents) || absents.length === 0) return 1
  let mod = 1
  for (const a of absents) {
    const imp = (a.importance || '').toLowerCase()
    if (imp !== 'titulaire' && imp !== 'rotation') continue
    const motif = (a.motif || '').toLowerCase()
    const isKeeper = /gardi|gk|keeper|arriere/i.test(motif) || /gardi/i.test(a.joueur || '')
    if (isKeeper) mod *= 0.88
    else if (imp === 'titulaire') mod *= 0.96
    else mod *= 0.98
  }
  return mod
}

function deVig(market) {
  const entries = Object.entries(market).filter(([, v]) => v && parseFloat(v) > 1)
  if (entries.length === 0) return null
  const inv = entries.map(([k, v]) => [k, 1 / parseFloat(v)])
  const sum = inv.reduce((acc, [, p]) => acc + p, 0)
  return Object.fromEntries(inv.map(([k, p]) => [k, p / sum]))
}

function pickMainMarket(probs) {
  const candidates = [
    { type: '1', prob: probs.win.home },
    { type: 'N', prob: probs.win.draw },
    { type: '2', prob: probs.win.away },
    { type: 'Over2.5', prob: probs.ou25 },
    { type: 'Under2.5', prob: probs.under25 },
    { type: 'BTTS_oui', prob: probs.btts.yes },
    { type: 'BTTS_non', prob: probs.btts.no },
  ]
  return candidates.reduce((best, c) => (c.prob > best.prob ? c : best), candidates[0])
}

function buildInputForMatch(match) {
  const fullData =
    typeof match.fullData === 'string' ? JSON.parse(match.fullData || '{}') : match.fullData || {}
  const formCtx = fullData.form_context || {}
  const standingH = match.form_context?.home?.standing || formCtx.home?.standing || null
  const standingA = match.form_context?.away?.standing || formCtx.away?.standing || null
  const teamStats =
    typeof match.teamStats === 'string'
      ? JSON.parse(match.teamStats || '{}')
      : match.teamStats || {}
  const tsH = teamStats.home || {}
  const tsA = teamStats.away || {}
  const lastMeetings =
    fullData.h2h_data?.teamDuel?.lastMeetings || match.h2h_data?.teamDuel?.lastMeetings || []

  const formA = synthForm(match.home_form_pts)
  const formB = synthForm(match.away_form_pts)

  const absentsA = []
  if (match.is_missing_gk)
    absentsA.push({ joueur: 'Gardien titulaire', motif: 'Absent', importance: 'titulaire' })
  if (match.is_missing_star)
    absentsA.push({ joueur: 'Joueur clé', motif: 'Absent', importance: 'titulaire' })
  if (match.is_missing_scorer)
    absentsA.push({ joueur: 'Meilleur buteur', motif: 'Absent', importance: 'titulaire' })
  const absentsB = []

  const input = {
    equipes: {
      nom: match.homeTeam || '',
      nom_b: match.awayTeam || '',
      championnat: match.league || '',
      classement: standingH?.rank || standingH?.position || 0,
      points: standingH?.points || 0,
      classement_b: standingA?.rank || standingA?.position || 0,
      points_b: standingA?.points || 0,
    },
    forme: formA,
    forme_b: formB,
    stats: {
      buts_marques_dom: tsH.avgGoalsScored || null,
      buts_encaisses_dom: tsH.avgGoalsConceded || null,
      buts_marques_ext: tsA.avgGoalsScored || null,
      buts_encaisses_ext: tsA.avgGoalsConceded || null,
      xg: match.home_xg || tsH.expectedGoals || 0,
      xg_b: match.away_xg || tsA.expectedGoals || 0,
      tirs_cadres: tsH.avgShotsOnTarget || null,
      possession: tsH.avgPossession || null,
      tirs_cadres_b: tsA.avgShotsOnTarget || null,
      possession_b: tsA.avgPossession || null,
    },
    h2h: lastMeetings.map((ev) => ({
      date: ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10) : '',
      score: `${ev.homeScore || 0}-${ev.awayScore || 0}`,
      domicile: ev.homeTeam || '',
    })),
    compositions: {
      absents_equipe_a: absentsA,
      absents_equipe_b: absentsB,
    },
    cotes: {
      1: match.odds_home || null,
      N: match.odds_draw || null,
      2: match.odds_away || null,
      over25: match.odds_over25 || null,
      under25: match.odds_under25 || null,
      btts_oui: match.odds_btts_yes || null,
      btts_non: match.odds_btts_no || null,
    },
    contexte: {
      enjeu: [
        match.is_high_pressure ? 'Match a enjeu élevé' : null,
        match.news_sentiment ? `Sentiment: ${match.news_sentiment}` : null,
        match.motivation_signature || null,
      ]
        .filter(Boolean)
        .join('; '),
      calendrier_charge: false,
      meteo: match.weather_desc
        ? `${match.weather_desc || ''} (${match.weather_temp ?? ''}°C)`
        : '',
      arbitre: match.referee || null,
    },
    _extras: {
      isHighPressure: !!match.is_high_pressure,
      newsSentiment: match.news_sentiment || null,
      marketValueH: match.home_market_value || 0,
      marketValueA: match.away_market_value || 0,
      attackImpactA: parseFloat(match.away_attack_impact) || 0,
      defenseImpactA: parseFloat(match.away_defense_impact) || 0,
      attackImpactB: parseFloat(match.home_attack_impact) || 0,
      defenseImpactB: parseFloat(match.home_defense_impact) || 0,
    },
  }
  return input
}

function synthForm(points) {
  const pts = parseFloat(points)
  if (!pts || isNaN(pts) || pts <= 0) return []
  const forme = []
  let rem = pts
  while (forme.length < 5) {
    if (rem >= 3) {
      forme.push({ resultat: 'V', score: '', domicile: true })
      rem -= 3
    } else if (rem >= 1) {
      forme.push({ resultat: 'N', score: '', domicile: true })
      rem -= 1
    } else {
      forme.push({ resultat: 'D', score: '', domicile: true })
    }
  }
  return forme
}

function analyze(input) {
  const risk = []

  const nameA = input.equipes?.nom || ''
  const nameB = input.equipes?.nom_b || ''
  const league = input.equipes?.championnat || ''

  const formeA = Array.isArray(input.forme) ? input.forme : []
  const formeB = Array.isArray(input.forme_b) ? input.forme_b : []
  if (formeA.length === 0) risk.push('Forme equipe A indisponible')
  if (formeB.length === 0) risk.push('Forme equipe B indisponible')

  const h2h = Array.isArray(input.h2h) ? input.h2h : []
  if (h2h.length === 0) risk.push('Historique H2H indisponible')
  else if (h2h.length < 3) risk.push(`Historique H2H faible (${h2h.length} match(s) seulement)`)

  const statsA = input.stats || {}
  const statsB = { ...statsA }
  if (input.stats?.buts_marques_ext) statsB.buts_marques_ext = input.stats.buts_marques_ext
  if (input.stats?.buts_encaisses_ext) statsB.buts_encaisses_ext = input.stats.buts_encaisses_ext
  if (input.stats?.xg_b) statsB.xg = input.stats.xg_b

  const xg = xgFromStats(statsA, statsB)
  const absA = input.compositions?.absents_equipe_a || []
  const absB = input.compositions?.absents_equipe_b || []
  const xgH = xg.h * absenceModifier(absA)
  const xgA = xg.a * absenceModifier(absB)
  if (absA.length > 0 || absB.length > 0) {
    risk.push(`${absA.length} absence(s) equipe A, ${absB.length} absence(s) equipe B`)
  }

  const probs = StatisticalEngine.calculateMarketProbs(xgH, xgA, { league })
  const market = { win: probs.win, btts: probs.btts, ou25: probs.ou[2.5], under25: probs.u[2.5] }

  const cotes = input.cotes || {}
  const devig = deVig({ 1: cotes[1], N: cotes.N, 2: cotes[2] })
  const devigOU = deVig({ over: cotes.over25, under: cotes.under25 })
  const devigBTTS = deVig({ oui: cotes.btts_oui, non: cotes.btts_non })
  if (!devig || !devigOU)
    risk.push('Cotes du marche incompletes (edge non calculable sur certains marches)')

  const probH = devig ? devig['1'] : null
  const probN = devig ? devig.N : null
  const probAway = devig ? devig['2'] : null
  const probOver = devigOU ? devigOU.over : null
  const probUnder = devigOU ? devigOU.under : null
  const probBttsY = devigBTTS ? devigBTTS.oui : null
  const probBttsN = devigBTTS ? devigBTTS.non : null

  const edges = []
  const addEdge = (type, est, mk) => {
    if (est == null || mk == null) return
    const edge = (est - mk) * 100
    if (edge >= 5) edges.push({ type, edge: Math.round(edge * 10) / 10, prob: est, marche: mk })
  }
  addEdge('1', market.win.home, probH)
  addEdge('N', market.win.draw, probN)
  addEdge('2', market.win.away, probAway)
  addEdge('Over2.5', market.ou25, probOver)
  addEdge('Under2.5', market.under25, probUnder)
  addEdge('BTTS_oui', market.btts.yes, probBttsY)
  addEdge('BTTS_non', market.btts.no, probBttsN)
  edges.sort((a, b) => b.edge - a.edge)
  const bestEdge = edges[0] || null

  const main = pickMainMarket(market)

  const facteurs = []
  const ptsA = weightedFormScore(formeA)
  const ptsB = weightedFormScore(formeB)
  if (ptsA !== null && ptsB !== null) {
    if (ptsA - ptsB > 0.6)
      facteurs.push(
        `${nameA} nettement meilleure forme (${ptsA.toFixed(2)} vs ${ptsB.toFixed(2)} pts/match)`
      )
    else if (ptsB - ptsA > 0.6)
      facteurs.push(
        `${nameB} nettement meilleure forme (${ptsB.toFixed(2)} vs ${ptsA.toFixed(2)} pts/match)`
      )
  }
  if (market.win.home >= market.win.away + 0.15)
    facteurs.push(
      `${nameA} domine le duel (${toPct(market.win.home)}% vs ${toPct(market.win.away)}%)`
    )
  else if (market.win.away >= market.win.home + 0.15)
    facteurs.push(
      `${nameB} domine le duel (${toPct(market.win.away)}% vs ${toPct(market.win.home)}%)`
    )
  if (absA.length + absB.length > 0)
    facteurs.push(`Absences: ${absA.length} (${nameA}), ${absB.length} (${nameB})`)
  if (h2h.length >= 3) facteurs.push(`H2H fiable sur ${h2h.length} rencontres`)
  if (input.contexte?.meteo) facteurs.push(`Meteo: ${input.contexte.meteo}`)

  const trap = detectTrap({
    market,
    probH,
    probAway,
    contexte: input.contexte,
    extras: input._extras,
  })

  const secondaries = [
    { type: '1', prob: market.win.home },
    { type: 'N', prob: market.win.draw },
    { type: '2', prob: market.win.away },
    { type: 'Over2.5', prob: market.ou25 },
    { type: 'Under2.5', prob: market.under25 },
    { type: 'BTTS_oui', prob: market.btts.yes },
    { type: 'BTTS_non', prob: market.btts.no },
  ]
    .filter((c) => c.type !== main.type)
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 3)
    .map((c) => ({ type: c.type, probabilite_estimee: Math.round(c.prob * 1000) / 1000 }))

  const scoreProbable = StatisticalEngine.findMostProbableScore(xgH, xgA, { league })

  const justification =
    `${main.type} est le marche le plus probable (${toPct(main.prob)}%). ` +
    `${nameA} (${formSummary(formeA)}) vs ${nameB} (${formSummary(formeB)})` +
    (bestEdge ? `; edge de ${bestEdge.edge} pts sur ${bestEdge.type}.` : '.')

  return {
    match: `${nameA} - ${nameB}`,
    competition: league,
    date: '',
    resume_forme: { equipe_a: formSummary(formeA), equipe_b: formSummary(formeB) },
    facteurs_cles: facteurs.slice(0, 5),
    pronostic_principal: {
      type: main.type,
      confiance: confidenceLabel(main.prob),
      probabilite_estimee: Math.round(main.prob * 1000) / 1000,
      justification,
    },
    pronostics_secondaires: secondaries,
    value_bet: {
      detecte: !!bestEdge,
      marche: bestEdge?.type || '',
      cote_marche: bestEdge ? 1 / bestEdge.marche : 0,
      probabilite_estimee: bestEdge ? Math.round(bestEdge.prob * 1000) / 1000 : 0,
      edge_pourcentage: bestEdge ? bestEdge.edge : 0,
    },
    piege_public: trap,
    facteurs_risque: risk.slice(0, 8),
    score_probable: scoreProbable,
  }
}

function detectTrap({ market, probH, probAway, contexte, extras }) {
  const hype =
    /derby|classico|classique|el cl|hype|revanche|choc|sommet/i.test(contexte?.enjeu || '') ||
    extras?.isHighPressure === true
  const crowdH = probH != null ? probH : market.win.home
  const crowdA = probAway != null ? probAway : market.win.away
  const modelH = market.win.home
  const modelA = market.win.away

  const hDelta = crowdH - modelH
  const aDelta = crowdA - modelA

  if (hype && hDelta > 0.25 && modelH < 0.5) {
    return {
      detecte: true,
      description: `Le public surcote ${'equipe A'} (${toPct(crowdH)}% cote vs ${toPct(modelH)}% modele) alors que la hype est forte; biais concret contredit par les donnees.`,
      equipe_surcotee: 'equipe_a',
    }
  }
  if (hype && aDelta > 0.25 && modelA < 0.5) {
    return {
      detecte: true,
      description: `Le public surcote ${'equipe B'} (${toPct(crowdA)}% cote vs ${toPct(modelA)}% modele) alors que la hype est forte; biais concret contredit par les donnees.`,
      equipe_surcotee: 'equipe_b',
    }
  }
  return { detecte: false, description: '', equipe_surcotee: '' }
}

function analyzeMatchFromDb(match) {
  if (!match) return null
  const input = buildInputForMatch(match)
  const result = analyze(input)
  result.date = match.startTimestamp
    ? new Date(match.startTimestamp > 1e11 ? match.startTimestamp : match.startTimestamp * 1000)
        .toISOString()
        .slice(0, 10)
    : ''
  return result
}

module.exports = { analyze, analyzeMatchFromDb, buildInputForMatch }
