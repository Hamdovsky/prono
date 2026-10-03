/**
 * settlementService.js — Automated Match Settlement Engine
 *
 * Periodically settles finished matches:
 * 1. Fetches missing scores from SofaAPI for finished matches
 * 2. Compares actual result with stored prediction (1/X/2, O/U)
 * 3. Writes WON/LOST to matches.result + prediction_history
 */

const db = require('../core/database')
const logger = require('../core/logger')
const confidenceScorer = require('../core/confidenceScorer')
const accuracyStore = require('../core/accuracyStore')

const SofaAPI = (() => {
  try {
    return require('../SofascoreScraping/src/apiClient').SofaAPI
  } catch {
    return null
  }
})()

// ── Market evaluation ─────────────────────────────────────────────

function evaluatePrediction(prediction, scoreHome, scoreAway, ou25Prob) {
  if (!prediction || prediction === 'UNDER ANALYSIS' || prediction === 'PENDING') return null
  if (scoreHome === null || scoreHome === undefined || scoreHome < 0) return null
  if (scoreAway === null || scoreAway === undefined || scoreAway < 0) return null

  const total = scoreHome + scoreAway

  // Compact O/U picks (O0.5, U0.5, O2.5, U2.5, O1.5 …)
  const ouCompact = prediction.match(/^([OU])(\d+(?:\.\d+)?)$/i)
  if (ouCompact) {
    const line = parseFloat(ouCompact[2])
    const isOver = ouCompact[1].toUpperCase() === 'O'
    if (isOver) return total > line ? 'WON' : 'LOST'
    return total < line ? 'WON' : 'LOST'
  }

  // O/U 2.5
  if (prediction.toUpperCase().startsWith('OVER') || prediction.toUpperCase().startsWith('O/U')) {
    const isOver = total > 2.5
    const isUnder = total < 2.5
    if (prediction.toUpperCase().includes('OVER')) return isOver ? 'WON' : 'LOST'
    if (prediction.toUpperCase().includes('UNDER')) return isUnder ? 'WON' : 'LOST'
    // Fallback using ou25Prob
    if (ou25Prob !== undefined && ou25Prob !== null) {
      return ou25Prob >= 50 ? (isOver ? 'WON' : 'LOST') : isUnder ? 'WON' : 'LOST'
    }
    return null
  }

  // BTTS (Both Teams To Score)
  if (prediction.toUpperCase().startsWith('BTTS') || prediction.toUpperCase().startsWith('GG')) {
    const bothScored = scoreHome > 0 && scoreAway > 0
    if (prediction.toUpperCase().includes('YES') || prediction.toUpperCase().includes('OUI'))
      return bothScored ? 'WON' : 'LOST'
    if (prediction.toUpperCase().includes('NO') || prediction.toUpperCase().includes('NON'))
      return bothScored ? 'LOST' : 'WON'
    return bothScored ? 'WON' : 'LOST'
  }

  // 1X2
  const isHome = prediction === '1'
  const isDraw = prediction === 'X'
  const isAway = prediction === '2'
  if (isHome) return scoreHome > scoreAway ? 'WON' : 'LOST'
  if (isDraw) return scoreHome === scoreAway ? 'WON' : 'LOST'
  if (isAway) return scoreHome < scoreAway ? 'WON' : 'LOST'

  // Double chance
  if (prediction === '1X') return scoreHome > scoreAway || scoreHome === scoreAway ? 'WON' : 'LOST'
  if (prediction === '12') return scoreHome > scoreAway || scoreHome < scoreAway ? 'WON' : 'LOST'
  if (prediction === 'X2') return scoreHome === scoreAway || scoreHome < scoreAway ? 'WON' : 'LOST'

  // Handicap
  const hcpMatch = prediction.match(/^([+-]?\d+(?:\.\d+)?)\s*(1|X|2)$/)
  if (hcpMatch) {
    const hcp = parseFloat(hcpMatch[1])
    const side = hcpMatch[2]
    const adjHome = scoreHome + hcp
    if (side === '1') return adjHome > scoreAway ? 'WON' : 'LOST'
    if (side === 'X') return adjHome === scoreAway ? 'WON' : 'LOST'
    if (side === '2') return adjHome < scoreAway ? 'WON' : 'LOST'
  }

  return null
}

function classifyMarket(prediction) {
  if (!prediction) return 'UNKNOWN'
  const p = prediction.toUpperCase()
  if (p === '1' || p === 'X' || p === '2') return '1X2'
  if (p === '1X' || p === '12' || p === 'X2') return 'DC'
  if (p.startsWith('OVER') || p.startsWith('UNDER') || p.startsWith('O/U')) return 'OU'
  if (p.startsWith('BTTS') || p.startsWith('GG')) return 'BTTS'
  if (p.match(/^[+-]?\d+(?:\.\d+)?\s*(1|X|2)$/)) return 'HCP'
  return 'OTHER'
}

// ── Core settlement ───────────────────────────────────────────────

/**
 * Extract the REAL engine pick (quant.main_pick from fullData) — the actual
 * prediction the dashboard shows (1X/12/O0.5/…), not the legacy `prediction`
 * column which is often a stale "1".
 */
function extractMainPick(row) {
  try {
    const fd = typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData || {}
    const q = fd.quant || fd.enriched?.quant || {}
    const pick = (q.main_pick || fd.main_pick || '').toString().trim().toUpperCase()
    if (pick && pick !== 'PENDING' && pick !== 'UNDER ANALYSIS') return pick
  } catch (e) {
    logger.debug(`[SETTLEMENT] extractMainPick parse failed for ${row && row.id}: ${e.message}`)
  }
  const colPick = (row.prediction || '').toString().trim().toUpperCase()
  if (colPick && colPick !== 'PENDING' && colPick !== 'UNDER ANALYSIS') return colPick
  return null
}

async function settleFinishedMatches(force = false) {
  logger.info('[SETTLEMENT] Checking for finished matches to settle...')

  const results = { settled: 0, total: 0, skipped: 0 }

  try {
    // Get finished matches with scores that are NOT yet settled
    const rows = db
      .prepare(
        `
            SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", 
                   prediction, league, "ou_25_prob", "home_win_probability", "draw_probability", "away_win_probability",
                   status, "insufficient_data", "startTimestamp", "fullData",
                   "odds_home", "odds_away", "odds_draw",
                   "best_odds_home", "best_odds_away"
            FROM matches
            WHERE status IN ('FT', 'finished', 'Finished', 'Ended')
              AND "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL
              AND (? = 1 OR "result" IS NULL OR "result" = '')
            ORDER BY "last_updated" DESC
            LIMIT 200
        `
      )
      .all(force ? 1 : 0)

    if (rows.length === 0) {
      logger.info('[SETTLEMENT] No matches to settle.')
      return { settled: 0, total: 0 }
    }

    logger.info(`[SETTLEMENT] Found ${rows.length} matches to settle.`)
    results.total = rows.length

    const now = Date.now()

    for (const row of rows) {
      try {
        const scoreHome = parseInt(row.scoreHome) || 0
        const scoreAway = parseInt(row.scoreAway) || 0

        // 🎯 REAL pick: quant.main_pick from fullData (combo DC / O0.5 / …)
        const mainPick = extractMainPick(row)
        let evalPick = mainPick || row.prediction
        let result = evalPick
          ? evaluatePrediction(evalPick, scoreHome, scoreAway, row.ou_25_prob)
          : null

        // If no primary prediction, infer ONLY from real probabilities (>0),
        // never fabricate a '1' when there is no data at all.
        if (!result) {
          const hProb = parseFloat(row.home_win_probability) || 0
          const dProb = parseFloat(row.draw_probability) || 0
          const aProb = parseFloat(row.away_win_probability) || 0
          const maxProb = Math.max(hProb, dProb, aProb)
          if (maxProb > 0) {
            let inferredPick = null
            if (maxProb === hProb) inferredPick = '1'
            else if (maxProb === dProb) inferredPick = 'X'
            else if (maxProb === aProb) inferredPick = '2'
            if (inferredPick) {
              result = evaluatePrediction(inferredPick, scoreHome, scoreAway, row.ou_25_prob)
              if (result) evalPick = inferredPick
            }
          }
        }

        if (!result) {
          // No real prediction (no pick, no probs) → purge any stale accuracy entry
          try {
            accuracyStore.removeResult(row.id)
          } catch (e) {
            logger.warn(`[SETTLEMENT] removeResult failed for ${row.id}: ${e.message}`)
          }
          // Reset any phantom settlement (from legacy forced-'1' logic)
          try {
            db.prepare('UPDATE matches SET "result" = NULL, "settled_at" = NULL WHERE id = ?').run(
              row.id
            )
          } catch (e) {
            logger.warn(`[SETTLEMENT] phantom reset failed for ${row.id}: ${e.message}`)
          }
          results.skipped++
          continue
        }

        // Update matches table
        db.prepare(
          `
                    UPDATE matches SET "result" = ?, "settled_at" = ? WHERE id = ?
                `
        ).run(result, now, row.id)

        // 📈 Suivi des Paris: mirror the settled outcome into the bets table
        try {
          syncBetToTracker(row, evalPick, result, scoreHome, scoreAway)
        } catch (e) {
          logger.warn(`[SETTLEMENT] syncBetToTracker failed for ${row.id}: ${e.message}`)
        }

        // Update prediction_history
        const histResult = result === 'WON' ? 'won' : 'lost'
        db.prepare(
          `
                    UPDATE prediction_history 
                    SET status = 'finished', result = ? 
                    WHERE match_id = ? AND status = 'pending'
                `
        ).run(histResult, row.id)

        results.settled++

        // Feed back into confidence history for league+market calibration
        try {
          const marketType = ['1X', 'X2', '12'].includes((mainPick || '').toUpperCase())
            ? 'DC'
            : classifyMarket(mainPick || row.prediction || '')
          confidenceScorer.recordSettlement(row.league || 'Unknown', marketType, result === 'WON')
        } catch (e) {
          logger.warn(`[SETTLEMENT] recordSettlement failed for ${row.id}: ${e.message}`)
        }

        // Write accuracy_log.json for Python training scripts feedback loop
        try {
          _appendToAccuracyLog(row, evalPick, result, scoreHome, scoreAway)
        } catch (e) {
          logger.warn(`[SETTLEMENT] _appendToAccuracyLog failed for ${row.id}: ${e.message}`)
        }

        logger.info(
          `[SETTLEMENT] ${row.homeTeam} ${scoreHome}-${scoreAway} ${row.awayTeam} → ${result} (prediction: ${evalPick})`
        )
      } catch (e) {
        logger.error(`[SETTLEMENT] Error settling ${row.id}: ${e.message}`)
      }
    }

    logger.info(`[SETTLEMENT] Done: ${results.settled} settled, ${results.skipped} skipped`)
  } catch (e) {
    logger.error(`[SETTLEMENT] Global error: ${e.message}`)
  }

  return results
}

// ── Fetch missing scores for finished matches ─────────────────────

async function fetchMissingScores() {
  logger.info('[SETTLEMENT] Fetching missing scores for finished matches...')

  if (!SofaAPI) {
    logger.warn('[SETTLEMENT] SofaAPI not available — cannot fetch missing scores.')
    return { fetched: 0 }
  }

  let fetched = 0

  try {
    // Find matches that should be finished but have no scores
    const rows = db
      .prepare(
        `
            SELECT m.id, m."homeTeam", m."awayTeam", m."fullData"
            FROM matches m
            WHERE m.status IN ('FT', 'finished', 'Finished', 'Ended')
              AND (m."scoreHome" IS NULL OR m."scoreHome" < 0 OR m."scoreAway" IS NULL OR m."scoreAway" < 0)
              AND ("result" IS NULL OR "result" = '')
            ORDER BY m."last_updated" DESC
            LIMIT 50
        `
      )
      .all()

    if (rows.length === 0) return { fetched: 0 }

    logger.info(`[SETTLEMENT] Found ${rows.length} matches with missing scores.`)

    for (const row of rows) {
      try {
        const details = await SofaAPI.getMatchDetails(row.id)
        if (!details || !details.event) continue

        const event = details.event
        if (event.status?.type !== 'finished' && event.status?.code !== 100) continue

        const homeScore = event.homeScore?.current ?? event.homeScore?.normaltime ?? null
        const awayScore = event.awayScore?.current ?? event.awayScore?.normaltime ?? null

        if (homeScore === null || awayScore === null) continue

        const currentFullData = JSON.parse(row.fullData || '{}')
        currentFullData.status = 'finished'
        currentFullData.score = { home: homeScore, away: awayScore }

        db.prepare(
          `
                    UPDATE matches 
                    SET "scoreHome" = ?, "scoreAway" = ?, "fullData" = ?
                    WHERE id = ?
                `
        ).run(homeScore, awayScore, JSON.stringify(currentFullData), row.id)

        logger.info(
          `[SETTLEMENT] Fetched score: ${row.homeTeam} ${homeScore}-${awayScore} ${row.awayTeam}`
        )
        fetched++

        await new Promise((r) => setTimeout(r, 1200))
      } catch (e) {
        logger.debug(`[SETTLEMENT] SofaAPI error for ${row.id}: ${e.message}`)
      }
    }
  } catch (e) {
    logger.error(`[SETTLEMENT] fetchMissingScores error: ${e.message}`)
  }

  return { fetched }
}

// ── Analytics ─────────────────────────────────────────────────────

function getPerformance() {
  const settled = db
    .prepare(
      `
        SELECT "result", prediction, "ou_25_prob", "home_win_probability", "scoreHome", "scoreAway",
               "fullData", "odds_home", "odds_draw", "odds_away", "odds_over25", "odds_under25"
        FROM matches
        WHERE "result" IN ('WON', 'LOST')
    `
    )
    .all()

  const total = settled.length
  const won = settled.filter((r) => r.result === 'WON').length
  const lost = settled.filter((r) => r.result === 'LOST').length
  const winRate = total > 0 ? Math.round((won / total) * 1000) / 10 : 0

  // ROI par unité plate : +0,85 par victoire, -1 par défaite, SANS lire la cote.
  // Ce n'est PAS un ROI financier, c'est un taux de réussite monnayé en unités.
  // On ne le supprime pas (le tableau de bord et l'AccuracyDashboard l'affichent),
  // mais il ne doit plus être présenté comme un ROI : voir `odds_based_*` ci-dessous.
  const profitUnits = settled.reduce((sum, r) => {
    return sum + (r.result === 'WON' ? 0.85 : -1)
  }, 0)
  const roiPercent = total > 0 ? Math.round((profitUnits / total) * 1000) / 10 : 0

  // ROI RÉELLEMENT FINANCIER : uniquement sur les matchs réglés pour lesquels une
  // VRAI prix de marché existe pour le pick joué. `_getPickOdds` retourne 0 quand
  // aucune cote n'est stockée : ces lignes sont exclues plutôt queFallback sur une
  // cote inventée, sinon on retombe dans l'artefact des cotes de repli.
  let stakedReal = 0
  let returnedReal = 0
  let realSettled = 0
  for (const r of settled) {
    const odds = _getPickOdds(r, r.prediction)
    if (!(odds > 1)) continue
    realSettled++
    stakedReal += 1
    if (r.result === 'WON') returnedReal += odds
  }
  const netReal = returnedReal - stakedReal
  const roiRealPercent =
    stakedReal > 0 ? Math.round((netReal / stakedReal) * 1000) / 10 : null

  // By confidence bracket (from home_win_probability or ou_25_prob)
  const brackets = {
    '0-50%': { won: 0, lost: 0 },
    '50-60%': { won: 0, lost: 0 },
    '60-70%': { won: 0, lost: 0 },
    '70-80%': { won: 0, lost: 0 },
    '80-90%': { won: 0, lost: 0 },
    '90%+': { won: 0, lost: 0 },
  }
  for (const r of settled) {
    const prob = parseFloat(r.home_win_probability) || parseFloat(r.ou_25_prob) || 50
    const bracket =
      prob < 50
        ? '0-50%'
        : prob < 60
          ? '50-60%'
          : prob < 70
            ? '60-70%'
            : prob < 80
              ? '70-80%'
              : prob < 90
                ? '80-90%'
                : '90%+'
    if (r.result === 'WON') brackets[bracket].won++
    else brackets[bracket].lost++
  }
  const byConfidence = {}
  for (const [bracket, counts] of Object.entries(brackets)) {
    const bTotal = counts.won + counts.lost
    byConfidence[bracket] = {
      won: counts.won,
      lost: counts.lost,
      total: bTotal,
      win_rate: bTotal > 0 ? Math.round((counts.won / bTotal) * 1000) / 10 : 0,
    }
  }

  // By market
  const markets = {}
  for (const r of settled) {
    const marketType = classifyMarket(r.prediction)
    if (!markets[marketType]) markets[marketType] = { won: 0, lost: 0 }
    if (r.result === 'WON') markets[marketType].won++
    else markets[marketType].lost++
  }
  const byMarket = {}
  for (const [market, counts] of Object.entries(markets)) {
    const mTotal = counts.won + counts.lost
    byMarket[market] = {
      won: counts.won,
      lost: counts.lost,
      total: mTotal,
      win_rate: mTotal > 0 ? Math.round((counts.won / mTotal) * 1000) / 10 : 0,
    }
  }

  // Weekly trend (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000
  const weeklyData = db
    .prepare(
      `
        SELECT "result", "settled_at" FROM matches
        WHERE "result" IN ('WON', 'LOST') AND "settled_at" >= ?
        ORDER BY "settled_at" ASC
    `
    )
    .all(sevenDaysAgo)

  const dailyMap = {}
  for (const r of weeklyData) {
    const day = new Date(r.settled_at).toISOString().split('T')[0]
    if (!dailyMap[day]) dailyMap[day] = { won: 0, lost: 0 }
    if (r.result === 'WON') dailyMap[day].won++
    else dailyMap[day].lost++
  }
  const trend = []
  for (const [day, counts] of Object.entries(dailyMap).sort()) {
    const dTotal = counts.won + counts.lost
    trend.push({
      date: day,
      won: counts.won,
      lost: counts.lost,
      total: dTotal,
      win_rate: dTotal > 0 ? Math.round((counts.won / dTotal) * 1000) / 10 : 0,
    })
  }

  // Confidence breakdown aggregation (from fullData._confidence_breakdown)
  const breakdownAcc = {
    baseScore: 0,
    dominanceScore: 0,
    drawAdjust: 0,
    bsmScore: 0,
    dataScore: 0,
    historyBonus: 0,
    count: 0,
  }
  for (const r of settled) {
    try {
      const fd = typeof r.fullData === 'string' ? JSON.parse(r.fullData) : r.fullData || {}
      const bd = fd._confidence_breakdown
      if (bd && typeof bd.baseScore === 'number') {
        breakdownAcc.baseScore += bd.baseScore
        breakdownAcc.dominanceScore += bd.dominanceScore
        breakdownAcc.drawAdjust += bd.drawAdjust
        breakdownAcc.bsmScore += bd.bsmScore
        breakdownAcc.dataScore += bd.dataScore
        breakdownAcc.historyBonus += bd.historyBonus
        breakdownAcc.count++
      }
    } catch (e) {
      logger.debug(`[SETTLEMENT] breakdown parse skipped for ${r.id}: ${e.message}`)
    }
  }
  const c = breakdownAcc.count
  const confidenceBreakdown =
    c > 0
      ? {
          base_prob: Math.round(breakdownAcc.baseScore / c),
          dominance_margin: Math.round(breakdownAcc.dominanceScore / c),
          draw_bias: Math.round(breakdownAcc.drawAdjust / c),
          bsm_quality: Math.round(breakdownAcc.bsmScore / c),
          data_quality: Math.round(breakdownAcc.dataScore / c),
          history_bonus: Math.round(breakdownAcc.historyBonus / c),
        }
      : null

  return {
    total_settled: total,
    won,
    lost,
    win_rate: winRate,
    // `roi_percent` / `profit_units` = unités plates, hors cote. Conservés pour
    // compatibilité mais ce ne sont pas des euros : ne pas les lire comme un ROI.
    roi_percent: roiPercent,
    profit_units: Math.round(profitUnits * 100) / 100,
    // --- ROI financier, cotes de marché réelles uniquement (E75) ---
    settled_with_odds: realSettled,
    odds_based_roi_percent: roiRealPercent,
    odds_based_profit_units: Math.round(netReal * 100) / 100,
    // true quand une partie des lignes réglées n'a aucune cote : les chiffres en
    // unités plates ci-dessus ne sont alors pas homogènes avec le reste.
    odds_partly_synthetic: realSettled < total,
    by_confidence: byConfidence,
    by_market: byMarket,
    trend,
    confidence_breakdown: confidenceBreakdown,
  }
}

// ── Accuracy log for Python training feedback ──────────────────────

function _appendToAccuracyLog(row, evalPick, result, scoreHome, scoreAway) {
  const league = row.league || 'Unknown'

  const hProb = parseFloat(row.home_win_probability) || 0
  const dProb = parseFloat(row.draw_probability) || 0
  const aProb = parseFloat(row.away_win_probability) || 0
  const confidence = Math.max(hProb, dProb, aProb)
  const predicted = evalPick || (row.prediction || '').toUpperCase() || '—'
  const actual = scoreHome > scoreAway ? '1' : scoreHome < scoreAway ? '2' : 'X'
  const isCorrect = result === 'WON'
  // vote_was_misleading : modèle très confiant (>60%) mais prediction erronée.
  // (Échelle 0..1 ici ; le .ts historique utilisait un seuil >60 sur une échelle
  //  0..100, donc toujours faux -> corrigé. Voir data_loader.apply_gap_learning_weight.)
  const wasMisleading = confidence > 0.60 && !isCorrect

  accuracyStore.appendResult({
    match_id: row.id,
    match: `${row.homeTeam} vs ${row.awayTeam}`,
    league,
    score: `${scoreHome}-${scoreAway}`,
    predicted,
    actual,
    is_correct: isCorrect,
    confidence: Math.round(confidence * 10) / 10,
    vote_was_misleading: wasMisleading,
    market: classifyMarket(predicted),
    timestamp: String(Date.now()),
  })
}

// ── Suivi des Paris (bets) mirror ─────────────────────────────────

// Résout la cote d'un pick. `allowSynthetic` = false (défaut) : ne renvoie un prix
// que s'il est RÉELLEMENT stocké, et 0 sinon.
//
// AVANT (E74), les doubles chances 1X/X2/12 retombaient sur des constantes
// inventées (h=2, a=2, d=3), donnant 1.20 / 1.20 / 1.00, et `buildBetRecord`
// (ligne ~628) remplaçait tout le reste par 2.00. Conséquence mesurée sur
// data/tactical.db : 11 994 lignes sur 13 156 (91,2%) de la table `bets` portaient
// une cote fabriquée, et c'est de là que venait l'intégralité du ROI +11,10%
// affiché sur /bets. Un prix de marché est une information, pas une valeur par
// défaut : si on ne l'a pas, on renvoie 0 et l'appelant décide (exclure la ligne,
// ou l'afficher comme non couverte) — jamais la fabrication silencieuse d'un prix.
//
// Pourquoi 1.00 est nécessairement synthétique : la somme des probabilités
// implicites d'un marché à marge est > 1, donc un prix de double chance « 12 »
// vaut 1/somme < 1. Une cote de 1.00 exacte ne peut venir que de h=a=2.
function _getPickOdds(row, pick, allowSynthetic = false) {
  const fd = (() => {
    try {
      return typeof row.fullData === 'string' ? JSON.parse(row.fullData) : row.fullData || {}
    } catch (_) {
      return {}
    }
  })()
  const first = (...keys) => {
    for (const k of keys) if (row[k] != null && row[k] !== '') return row[k]
    for (const k of keys) if (fd[k] != null && fd[k] !== '') return fd[k]
    return undefined
  }
  const p = (pick || '').toString().trim().toUpperCase()

  if (p === '1' || p === 'HOME')
    return parseFloat(first('odds_home', 'best_odds_home', 'display_odds_home') || 0)
  if (p === '2' || p === 'AWAY')
    return parseFloat(first('odds_away', 'best_odds_away', 'display_odds_away') || 0)
  if (p === 'X' || p === 'DRAW') return parseFloat(first('odds_draw') || 0)
  if (p === '1X' || p === 'X2' || p === '12') {
    // Un double chance se déduit de deux cotes SIMPLES. Si l'une des deux
    // manque, il n'y a pas de prix réel : on ne comble pas.
    const hRaw = first('odds_home', 'best_odds_home', 'display_odds_home')
    const aRaw = first('odds_away', 'best_odds_away', 'display_odds_away')
    const dRaw = first('odds_draw')
    const h = parseFloat(hRaw || 0)
    const a = parseFloat(aRaw || 0)
    const d = parseFloat(dRaw || 0)
    let need
    if (p === '1X') need = [h, d]
    else if (p === 'X2') need = [a, d]
    else need = [h, a]
    const complete = need.every((x) => Number.isFinite(x) && x > 1)
    if (!complete) {
      if (!allowSynthetic) return 0
      const hh = h > 1 ? h : 2
      const aa = a > 1 ? a : 2
      const dd = d > 1 ? d : 3
      if (p === '1X') return 1 / (1 / hh + 1 / dd)
      if (p === 'X2') return 1 / (1 / aa + 1 / dd)
      return 1 / (1 / hh + 1 / aa)
    }
    const prob = p === '1X' ? 1 / h + 1 / d : p === 'X2' ? 1 / a + 1 / d : 1 / h + 1 / a
    return prob > 0 ? 1 / prob : 0
  }
  // Marchés O/U et BTTS : une cote simple, réelle ou rien.
  // ATTENTION à ne pas confondre les lignes : le pick « O0.5 » (au moins un but)
  // et « OVER 2.5 » ne sont pas le même marché — un prix de ~1,05 contre ~2,0.
  // On ne résout donc que si la ligne demandée est bien celle qui est stockée,
  // sinon 0 (aucun prix réel pour ce marché), pas un prix d'une autre ligne.
  const up = p.replace(/[\s_.-]/g, '')
  if (up === 'OVER25' || up === 'O25' || up === 'O2.5')
    return parseFloat(first('odds_over25', 'odds_over') || 0)
  if (up === 'UNDER25' || up === 'U25' || up === 'U2.5')
    return parseFloat(first('odds_under25', 'odds_under') || 0)
  if (up === 'BTTSYES' || up === 'BTTS')
    return parseFloat(first('odds_btts_yes') || 0)
  if (up === 'BTTSNO')
    return parseFloat(first('odds_btts_no') || 0)
  return 0
}

function _matchDate(row) {
  const rawTs = row.startTimestamp
  if (!rawTs) return new Date().toISOString().split('T')[0]
  let ms = 0
  if (typeof rawTs === 'string' && rawTs.includes('T')) ms = new Date(rawTs).getTime()
  else ms = parseInt(rawTs) > 1e11 ? parseInt(rawTs) : parseInt(rawTs) * 1000
  if (isNaN(ms)) return new Date().toISOString().split('T')[0]
  return new Date(ms).toISOString().split('T')[0]
}

/**
 * Build the bet row that mirrors a settled outcome into the `bets` table.
 * Pure: returns null when there is no pick or when the match+pick is already
 * tracked (idempotency). Stake = 1 flat unit; odds fall back to 2.0 when none
 * are stored (e.g. O/U picks).
 */
function buildBetRecord(row, pick, result, scoreHome, scoreAway) {
  if (!pick) return null
  const label = `${row.homeTeam || '?'} vs ${row.awayTeam || '?'}`
  const existing = db
    .prepare('SELECT id FROM bets WHERE match_label = ? AND pick = ?')
    .get(label, pick)
  if (existing) return null

  const odds = Math.round(_getPickOdds(row, pick) * 100) / 100 || 2
  const betResult = result === 'WON' ? 'won' : result === 'LOST' ? 'lost' : 'pending'
  const profit =
    betResult === 'won'
      ? Math.round((odds - 1) * 100) / 100
      : betResult === 'lost'
        ? -1
        : 0

  return {
    match_label: label,
    league: row.league || '',
    pick,
    odds,
    stake: 1,
    result: betResult,
    profit,
    note: `${scoreHome}-${scoreAway}`,
    date: _matchDate(row),
  }
}

/**
 * Mirror a settled outcome into the `bets` table (📈 Suivi des Paris).
 * Idempotent: a match+pick is tracked only once. Pass { dryRun: true } to
 * preview what would be inserted without writing (used by backfill_bets.js).
 */
function syncBetToTracker(row, pick, result, scoreHome, scoreAway, opts = {}) {
  const record = buildBetRecord(row, pick, result, scoreHome, scoreAway)
  if (!record) return

  if (!opts.dryRun) {
    db.prepare(
      'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, note, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      record.match_label,
      record.league,
      record.pick,
      record.odds,
      record.stake,
      record.result,
      record.profit,
      record.note,
      record.date
    )
  }
  logger.info(
    `[SETTLEMENT] ${opts.dryRun ? '[DRY-RUN] ' : ''}📈 Bet tracked: ${record.match_label} ${record.note} → ${record.result} (${record.pick} @ ${record.odds})`
  )
  return record
}

/**
 * Normalize a historical_matches row into a settlement-like row (startTimestamp
 * derived from the ISO timestamp column when absent).
 */
function _normalizeHistRow(r) {
  const row = { ...r }
  if (row.startTimestamp === undefined || row.startTimestamp === null) {
    if (row.timestamp) {
      const iso = String(row.timestamp)
      row.startTimestamp = iso.includes('T') ? iso : `${iso}T00:00:00Z`
    }
  }
  return row
}

/**
 * Backfill 📈 Suivi des Paris from already-settled matches, so past finished
 * games that were archived before the settlement cycle could mirror them also
 * appear in the bets tracker. Idempotent (match_label + pick) and supports
 * --dry-run (no writes).
 *
 * Sources:
 *  - A: matches still present with a stored settlement result (WON/LOST)
 *  - B: historical_matches (archived finished matches, fullData keeps the real pick)
 */
async function backfillBets({ dryRun = false, limit = 1000 } = {}) {
  const summary = {
    scanned: 0,
    inserted: 0,
    wouldInsert: 0,
    alreadyPresent: 0,
    skipped: 0,
    errors: 0,
  }

  const track = (row, pick, result, sh, sa) => {
    if (!pick || !result) {
      summary.skipped++
      return
    }
    const record = buildBetRecord(row, pick, result, sh, sa)
    if (!record) {
      summary.alreadyPresent++
      return
    }
    if (dryRun) {
      summary.wouldInsert++
      return
    }
    try {
      db.prepare(
        'INSERT INTO bets (match_label, league, pick, odds, stake, result, profit, note, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        record.match_label,
        record.league,
        record.pick,
        record.odds,
        record.stake,
        record.result,
        record.profit,
        record.note,
        record.date
      )
      summary.inserted++
    } catch (e) {
      summary.errors++
      logger.warn(`[BACKFILL] Insert error for ${record.match_label}: ${e.message}`)
    }
  }

  try {
    const settled = db
      .prepare(
        `
            SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", league,
                   prediction, "fullData", "startTimestamp", result,
                   "odds_home", "odds_away", "odds_draw", "best_odds_home", "best_odds_away"
            FROM matches
            WHERE "result" IN ('WON', 'LOST') AND "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL
            ORDER BY "settled_at" DESC
            LIMIT ?
        `
      )
      .all(limit)

    for (const row of settled) {
      summary.scanned++
      const sh = parseInt(row.scoreHome) || 0
      const sa = parseInt(row.scoreAway) || 0
      const evalPick = extractMainPick(row) || row.prediction
      track(row, evalPick, row.result, sh, sa)
    }

    const archived = db
      .prepare(
        `
            SELECT id, "homeTeam", "awayTeam", "scoreHome", "scoreAway", league,
                   "fullData", timestamp
            FROM historical_matches
            WHERE "scoreHome" IS NOT NULL AND "scoreAway" IS NOT NULL
            ORDER BY archived_at DESC
            LIMIT ?
        `
      )
      .all(limit)

    for (const r of archived) {
      summary.scanned++
      const row = _normalizeHistRow(r)
      const sh = parseInt(row.scoreHome) || 0
      const sa = parseInt(row.scoreAway) || 0
      const evalPick = extractMainPick(row)
      const result = evalPick ? evaluatePrediction(evalPick, sh, sa) : null
      track(row, evalPick, result, sh, sa)
    }
  } catch (e) {
    logger.error(`[BACKFILL] Error: ${e.message}`)
    summary.errors++
  }

  logger.info(
    `[BACKFILL] ${dryRun ? '[DRY-RUN] ' : ''}scanned=${summary.scanned} ` +
      `inserted=${summary.inserted} wouldInsert=${summary.wouldInsert} ` +
      `alreadyPresent=${summary.alreadyPresent} skipped=${summary.skipped} errors=${summary.errors}`
  )
  return summary
}

// 🧹 Balayage nocturne des « scheduled » fantômes : matchs jamais réglés par
// le pass résultats (fenêtre J-3..J-1 dépassée, ligue non couverte, source
// morte). On ne supprime RIEN — le statut passe à 'canceled' (seul
// DEAD_STATUSES reconnu côté frontend) et last_updated est touché, tout
// reste restaurable via startTimestamp/scoreHome intacts. (2026-09-09 : 1373
// lignes scheduled > 2 jours traînaient avec des scores placeholder 0-0.)
function purgeStaleScheduled(maxAgeDays = 2) {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400
  try {
    const info = db
      .prepare(
        `UPDATE matches
         SET status = 'canceled', last_updated = ?
         WHERE status IN ('scheduled','upcoming','NOT_STARTED','NS')
           AND ? > startTimestamp
           AND startTimestamp > 0`
      )
      .run(Date.now(), cutoff)
    const n = info.changes || 0
    if (n > 0) logger.info(`[SETTLEMENT] Purge stale scheduled: ${n} rows → 'canceled' (kickoff > ${maxAgeDays}j, sans score).`)
    return { canceled: n }
  } catch (e) {
    logger.error(`[SETTLEMENT] purgeStaleScheduled failed: ${e.message}`)
    return { canceled: 0, error: e.message }
  }
}

module.exports = {
  settleFinishedMatches,
  fetchMissingScores,
  getPerformance,
  evaluatePrediction,
  buildBetRecord,
  syncBetToTracker,
  backfillBets,
  purgeStaleScheduled,
  // Exporté pour __tests__/betsOddsIntegrity.test.js : la résolution de cote est
  // interne, mais c'est elle qui fabrique les prix. Doit rester verrouillée par
  // des tests, sinon le défaut revient.
  __test_getPickOdds: _getPickOdds,
}
