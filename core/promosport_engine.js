const logger = require('./logger');
const mlPredictionService = require('../services/mlPredictionService');
const doubleOptimizer = require('../services/doubleOptimizerService');
const db = require('./database');

// ─── xG→Probabilities (Poisson Approximation) ────────────────────────────────
function xgToProbs(xgHome, xgAvgHome, xgAvgAway) {
  const λh = Math.max(0.1, xgHome);
  const λa = Math.max(0.1, xgAvgAway || xgHome * 0.7);
  const d = λh - λa;
  const t = λh + λa;
  const drawP = 0.26 * Math.exp(-Math.abs(d) / 3.0);
  const scaling = 1.0 - drawP;
  const p1 = scaling * λh / (λh + λa);
  const p2 = scaling * λa / (λh + λa);
  return { p1, px: drawP, p2 };
}

// ─── Smart Fallback: xG DB → Poisson → Probabilities ─────────────────────────
async function smartFallbackWithXg(match) {
  try {
    const xgHome = await db.getTeamAvgXg(match.homeTeam);
    const xgAway = await db.getTeamAvgXg(match.awayTeam);
    const xgH = xgHome?.overallAvg;
    const xgA = xgAway?.overallAvg;
    if (xgH && xgA) {
      const { p1, px, p2 } = xgToProbs(xgH, xgH, xgA);
      logger.info(`🧪 [xG Fallback] ${match.homeTeam} vs ${match.awayTeam}: xG ${xgH.toFixed(2)}-${xgA.toFixed(2)} → ${(p1*100).toFixed(0)}/${(px*100).toFixed(0)}/${(p2*100).toFixed(0)}`);
      return { p1, px, p2 };
    }
  } catch (e) {
    logger.warn(`⚠️ [xG Fallback] DB query failed for ${match.homeTeam}: ${e.message}`);
  }
  return null;
}


/**
 * Deterministic pseudo-random number based on a string seed.
 * Returns a float in [0, 1) — STABLE for the same seed (no Math.random()).
 */
function seededRand(seed) {
    let hash = 0;
    const str = String(seed);
    for (let i = 0; i < str.length; i++) {
        hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
    }
    // Convert to [0, 1) using unsigned right shift (100k steps for precision)
    return ((hash >>> 0) % 100000) / 100000;
}

async function generatePromosportGrids(scrapedMatches, customDoubles) {
  if (!scrapedMatches || scrapedMatches.length === 0) {
    logger.warn('[PROMOSPORT-ENGINE] No scraped matches provided');
    return null;
  }

  try {
    // 1. Get ML Predictions for all matches in PARALLEL to avoid sequential queue starvation
    logger.info(`🧠 [PROMOSPORT-ENGINE] Processing ${scrapedMatches.length} matches through AI Engine in parallel...`);
    
    const enrichedMatches = await Promise.all(scrapedMatches.map(async (m) => {
        try {
            // A. Resolve Aliases
            const homeAlias = await db.resolveTeamName(m.homeTeam);
            const awayAlias = await db.resolveTeamName(m.awayTeam);
            
            // B. Search for the match in our DB to get RICH data
            const dbMatch = await db.getMatchById(`${homeAlias}_${awayAlias}`) || 
                            await db.getMatchById(`${awayAlias}_${homeAlias}`);

            const bestMatchData = dbMatch ? { ...dbMatch, ...m } : m;
            
            // C. Call ML Prediction (Deduplicated inside mlPredictionService)
            let pred = await mlPredictionService.getMLPrediction(bestMatchData).catch(e => {
                logger.warn(`⚠️ [PROMOSPORT-ENGINE] Prediction failed for ${m.homeTeam}: ${e.message}`);
                return {};
            });
            if (!pred) pred = {};
          
            let p1 = pred.probabilities?.home ?? pred.home_win_probability ?? m.homeWinProbability ?? null;
            let px = pred.probabilities?.draw ?? pred.draw_probability ?? m.drawProbability ?? null;
            let p2 = pred.probabilities?.away ?? pred.away_win_probability ?? m.awayWinProbability ?? null;
          
            // Detect flat/stale probabilities (33/33/34 from scraper default)
            const isFlat = (
              p1 !== null && px !== null && p2 !== null &&
              Math.abs(p1 - 0.33) < 0.05 && Math.abs(px - 0.33) < 0.05 && Math.abs(p2 - 0.34) < 0.05
            );

            // Try team-specific historical Promosport stats from archive
            let teamStats = null;
            if (isFlat || p1 === null || px === null || p2 === null) {
                teamStats = db.getTeamPromosportStats(m.homeTeam) || db.getTeamPromosportStats(m.awayTeam);
            }

            if (isFlat) {
              if (teamStats) {
                const p1Team = teamStats.homeWinRate !== null ? teamStats.homeWinRate : 0.424;
                const pxTeamHome = teamStats.homeDrawRate !== null ? teamStats.homeDrawRate : 0.259;
                const p2Team = teamStats.awayWinRate !== null ? teamStats.awayWinRate : 0.317;
                const pxTeamAway = teamStats.awayDrawRate !== null ? teamStats.awayDrawRate : 0.259;

                p1 = (p1Team * 0.7 + 0.424 * 0.3);
                px = (pxTeamHome * 0.35 + pxTeamAway * 0.35 + 0.259 * 0.3);
                p2 = (p2Team * 0.7 + 0.317 * 0.3);
                logger.info(`🧪 [PROMOSPORT-ENGINE] Archive stats used for ${m.homeTeam} (${teamStats.homeGames}H/${teamStats.awayGames}A)`);
              } else {
                // Try xG-based smart fallback from tactical.db
                const xgFallback = await smartFallbackWithXg(m);
                if (xgFallback) {
                  p1 = xgFallback.p1; px = xgFallback.px; p2 = xgFallback.p2;
                  logger.info(`🧪 [PROMOSPORT-ENGINE] xG fallback used for ${m.homeTeam} vs ${m.awayTeam}`);
                } else {
                  p1 = 0.424; px = 0.259; p2 = 0.317;
                  logger.info(`🧪 [PROMOSPORT-ENGINE] Historical distribution used for ${m.homeTeam}`);
                }
              }
            }

            // If null, safe fallback with REAL historical distribution (4,790 match analysis)
            if (p1 === null || px === null || p2 === null) {
                if (teamStats) {
                  p1 = teamStats.homeWinRate !== null ? teamStats.homeWinRate : 0.424;
                  px = (teamStats.homeDrawRate || 0.259) * 0.5 + (teamStats.awayDrawRate || 0.259) * 0.5;
                  p2 = teamStats.awayWinRate !== null ? teamStats.awayWinRate : 0.317;
                } else {
                  p1 = 0.424;
                  px = 0.259;
                  p2 = 0.317;
                }
            }

            // Normalize probabilities if in 0-100% format
            if (p1 > 1.0 || px > 1.0 || p2 > 1.0) {
                p1 = p1 / 100;
                px = px / 100;
                p2 = p2 / 100;
            }
            const total = p1 + px + p2
            p1 /= total; px /= total; p2 /= total
          
            const H = - (p1 * Math.log2(Math.max(0.01, p1)) + px * Math.log2(Math.max(0.01, px)) + p2 * Math.log2(Math.max(0.01, p2)));
          
            const isHighPressure = dbMatch?.is_high_pressure || (m.intel?.motivation > 85);
            const pressureMultiplier = isHighPressure ? 1.12 : 1.0;
            const confidence = pred.confidence || Math.max(50, 80 - (H * 15));

            let crowdP1 = m.homeWinProbability || 0.33;
            let crowdP2 = m.awayWinProbability || 0.34;
            if (crowdP1 > 1) crowdP1 /= 100
            if (crowdP2 > 1) crowdP2 /= 100
            const p1Delta = crowdP1 - p1;
            const p2Delta = crowdP2 - p2;
            const isCrowdTrap = (p1Delta > 0.25 && p1 < 0.50);
            const isAwayCrowdTrap = (p2Delta > 0.25 && p2 < 0.50);
            const publicOverconfidence = (
              (crowdP1 > 0.55 && p1 < crowdP1 * 0.7) ||
              (crowdP2 > 0.55 && p2 < crowdP2 * 0.7)
            );
            const publicConfidence = Math.max(crowdP1, crowdP2, 1 - crowdP1 - crowdP2);

            return {
                ...m,
                p1: Math.min(0.95, p1 * pressureMultiplier),
                px, p2,
                entropy: H,
                confidence: confidence,
                isHighPressure,
                isCrowdTrap,
                isAwayCrowdTrap,
                publicOverconfidence,
                publicConfidence,
                crowdP1, crowdP2,
                intel: pred.intel || {
                    form: 60 + seededRand(`${m.homeTeam}_form`) * 20,
                    logistics: 70 + seededRand(`${m.awayTeam}_logistics`) * 10,
                    motivation: isHighPressure ? 95 : 75,
                    sharp: confidence
                },
                tacticalBrief: isAwayCrowdTrap
                    ? `🚨 ALERTE PIÈGE EXTERIEUR : Le public surestime ${m.awayTeam}.`
                    : (isCrowdTrap 
                        ? `🚨 ALERTE PIÈGE DOMICILE : Le public surestime ${m.homeTeam}.`
                        : (publicOverconfidence
                            ? `⚠️ PIÈGE POTENTIEL: Le public trop confiant (${(publicConfidence*100).toFixed(0)}%).`
                            : (pred.brief || (isHighPressure ? '⚠️ MATCH À HAUTE PRESSION.' : 'Analyse basée sur les probabilités de base.'))))
            };
        } catch (e) {
            logger.error(`❌ [PROMOSPORT-ENGINE] Failed to enrich match ${m.homeTeam}:`, e.message);
            return { ...m, p1: null, px: null, p2: null, entropy: null, confidence: null, hasData: false, intel: { form: null, logistics: null, motivation: null, sharp: null }, tacticalBrief: 'Enrichment failed.' };
        }
    }));


    // 2. Generate the 4 specialized grids with STRATEGIC DIVERSIFICATION
    const result = generateGridsWithStrategicCoverage(enrichedMatches, customDoubles);
    return result;
  } catch (err) {
    logger.error('[PROMOSPORT-ENGINE] Grid generation failed:', err.message);
    throw err;
  }
}

/**
 * Advanced Strategic Coverage: Ensures the 4 grids complement each other.
 */
function generateGridsWithStrategicCoverage(enrichedMatches, customDoubles) {
  const defaults = [6, 6, 6, 6];
  const cd = (Array.isArray(customDoubles) && customDoubles.length === 4)
    ? customDoubles.map((d, i) => Math.max(0, Math.min(13, parseInt(d) || defaults[i])))
    : defaults;
  const gridConfigs = [
    { id: 'T1', name: 'EDGE OPTIMIZED', doubles: cd[0], bias: 'fav' },
    { id: 'T2', name: 'ANTI-CROWD', doubles: cd[1], bias: 'upset' },
    { id: 'T3', name: 'HIGH VALUE', doubles: cd[2], bias: 'draw' },
    { id: 'T4', name: 'SECURE BANKER', doubles: cd[3], bias: 'safe' }
  ];

  const grids = [];

  const obstacleAnalysis = analyseObstacles(enrichedMatches)
  logger.info(`🧠 [OBSTACLES] Avg score: ${(obstacleAnalysis.reduce((a,o) => a + o.avgScore, 0) / 13).toFixed(2)}/5`)

  // ── Cross-Distribution of doubles across 4 grids ────────────────
  // Rank matches by uncertainty (entropy + crowd traps - confidence)
  const rankedByUncertainty = enrichedMatches
    .map(m => ({
      id: m.id,
      uncertainty: m.entropy + (m.isCrowdTrap || m.isAwayCrowdTrap ? 2 : 0) + (m.publicOverconfidence ? 1 : 0) - (m.confidence / 100) * 0.5
    }))
    .sort((a, b) => b.uncertainty - a.uncertainty)

  // Top 3 most uncertain → doubled by ALL 4 grids (core)
  const coreDoubles = rankedByUncertainty.slice(0, 3).map(m => m.id)

  // Dynamic singles: un match n'est simple que si confiance > 75%
  const MIN_CONFIDENCE_SINGLE = 75
  const candidateSingles = rankedByUncertainty.slice(3, 13)
    .map(r => ({ id: r.id, match: enrichedMatches.find(m => m.id === r.id) }))
  candidateSingles.sort((a, b) => (b.match.confidence || 0) - (a.match.confidence || 0))

  const singlesList = candidateSingles
    .filter(c => (c.match.confidence || 0) >= MIN_CONFIDENCE_SINGLE)
    .slice(0, 4)
    .map(c => c.id)

  const singlesCount = singlesList.length
  const mediumPool = candidateSingles
    .filter(c => !singlesList.includes(c.id))
    .map(c => c.id)

  // Round-robin: chaque match medium est doublé par exactement 2 grilles
  // On distribue uniformément pour que chaque grille ait ~mediumCount*2/4 doublons
  const mediumAssignments = Array.from({ length: 4 }, () => [])
  for (let mi = 0; mi < mediumPool.length; mi++) {
    // Chaque match medium est assigné à 2 grilles décalées
    const g1 = mi % 4
    const g2 = (mi + 2) % 4
    mediumAssignments[g1].push(mi)
    mediumAssignments[g2].push(mi)
  }

  const gridDoubleMap = {}
  gridConfigs.forEach((_, gi) => {
    gridDoubleMap[gi] = [
      ...coreDoubles,
      ...mediumAssignments[gi].map(idx => mediumPool[idx])
    ]
  })

  logger.info(`[PROMOSPORT-ENGINE] Distribution: ${coreDoubles.length} core + ${mediumPool.length} medium + ${singlesList.length} singles`)

  gridConfigs.forEach((config, gridIdx) => {
    const doubleIds = gridDoubleMap[gridIdx]

    const gridMatches = enrichedMatches.map(m => {
      const isDouble = doubleIds.includes(m.id);
      let choices = [];

      // Primary Selection based on Bias
      if (config.bias === 'safe') {
        const max = Math.max(m.p1, m.px, m.p2);
        choices.push(m.p1 === max ? '1' : (m.p2 === max ? '2' : 'X'));
      } else if (config.bias === 'draw') {
        if (m.px > 0.30) choices.push('X');
        else choices.push(m.p1 > m.p2 ? '1' : '2');
      } else if (config.bias === 'upset') {
        if (m.p1 > 0.65) choices.push('1'); 
        else if (m.p2 > 0.25) choices.push('2');
        else choices.push('X');
      } else {
        if (m.p1 > 0.45) choices.push('1');
        else if (m.p2 > 0.40) choices.push('2');
        else choices.push('X');
      }

      // Strategic Double Logic: "Complementary Coverage"
      if (isDouble) {
        if (m.bsd_prediction && choices[0]) {
          const bsdPicks = { '1': '1', 'HOME': '1', 'X': 'X', 'DRAW': 'X', '2': '2', 'AWAY': '2' }
          const bsdWinner = bsdPicks[String(m.bsd_prediction).trim().toUpperCase()];
          if (bsdWinner && !choices.includes(bsdWinner)) {
              choices.push(bsdWinner);
          }
        }
        
        const probs = [
            {v: '1', p: m.p1},
            {v: 'X', p: m.px},
            {v: '2', p: m.p2}
        ].sort((a, b) => b.p - a.p);

        const first = choices[0];
        let second;
        if (config.bias === 'upset' && !choices.includes('2')) second = '2';
        else if (config.bias === 'draw' && !choices.includes('X')) second = 'X';
        else second = (probs[0].v === first) ? probs[1].v : probs[0].v;
        
        choices.push(second);
      }

      choices = [...new Set(choices)].sort((a, b) => {
          const order = {'1': 0, 'X': 1, '2': 2};
          return order[a] - order[b];
      });

      return {
        id: m.id,
        home: m.homeTeam,
        away: m.awayTeam,
        p1: m.p1,
        px: m.px,
        p2: m.p2,
        entropy: m.entropy,
        confidence: m.confidence,
        isCrowdTrap: m.isCrowdTrap,
        isAwayCrowdTrap: m.isAwayCrowdTrap,
        publicOverconfidence: m.publicOverconfidence,
        publicConfidence: m.publicConfidence,
        crowdP1: m.crowdP1,
        crowdP2: m.crowdP2,
        choices: choices,
        intel: m.intel,
        brief: m.tacticalBrief,
        isHighPressure: m.isHighPressure
      };
    });

    grids.push({
      gridNumber: gridIdx + 1,
      name: config.name,
      matches: gridMatches,
      stats: {
        totalDoubles: config.doubles,
        coverageIndex: (config.doubles / 13 * 100).toFixed(0) + '%',
        avgConfidence: (enrichedMatches.reduce((acc, m) => acc + m.confidence, 0) / 13).toFixed(1)
      }
    });
  });

  // DIVERSIFICATION PASS — Anti-piège public + Obstacle Awareness
  const matchCount = enrichedMatches.length;
  for (let mi = 0; mi < matchCount; mi++) {
    const picksStr = grids.map(g => [...g.matches[mi].choices].sort().join(''))
    const unique = [...new Set(picksStr)]
    const m = enrichedMatches[mi]
    const obs = obstacleAnalysis[mi]

    // Check if obstacle score is high (> 3.5) — force extra coverage
    const highObstacleRisk = obs && obs.avgScore > 3.5

    if (unique.length === 1 && unique[0].length === 1) {
      const currentPick = unique[0]

      const crowdP = currentPick === '1' ? (m.crowdP1 || m.homeWinProbability || 0)
                   : currentPick === '2' ? (m.crowdP2 || m.awayWinProbability || 0)
                   : (m.drawProbability || 0)
      const total = (m.homeWinProbability || 0.33) + (m.drawProbability || 0.33) + (m.awayWinProbability || 0.34)
      const crowdPct = total > 0 ? crowdP / total : 0

      const forceDiversify = (
        crowdPct > 0.50 ||
        m.publicOverconfidence ||
        m.isCrowdTrap ||
        m.isAwayCrowdTrap ||
        highObstacleRisk
      )

      if (forceDiversify) {
        const alternatives = ['1', 'X', '2'].filter(p => p !== currentPick)
        const mlProbs = { '1': m.p1 || 0.33, 'X': m.px || 0.33, '2': m.p2 || 0.34 }
        alternatives.sort((a, b) => mlProbs[b] - mlProbs[a])

        // Diversify HIGH VALUE grid (index 2) on high obstacles, SECURE BANKER (3) on crowd traps
        const gi = (highObstacleRisk && !m.isCrowdTrap && !m.isAwayCrowdTrap) ? 2 : 3
        if (grids[gi]) {
          const targetMatch = grids[gi].matches[mi]
          targetMatch.choices = [alternatives[0]]
          targetMatch.diversified = true
          const reason = highObstacleRisk
            ? `🛡️ OBSTACLE ${obs.avgScore}/5: foule ${(crowdPct*100).toFixed(0)}% sur ${currentPick}, diversification ${alternatives[0]}`
            : `🛡️ ANTI-PIÈGE PUBLIC: foule ${(crowdPct*100).toFixed(0)}% sur ${currentPick}, nous prenons ${alternatives[0]}`
          targetMatch.diversifyReason = reason
          targetMatch.brief = (targetMatch.brief || '') + ' | ' + reason
        }
      }
    }

    // Extra double on high-obstacle matches in SECURE BANKER grid (index 3)
    if (highObstacleRisk && obs.avgScore > 4.0 && grids[3]) {
      const antiCrowdMatch = grids[1].matches[mi]
      if (antiCrowdMatch.choices.length === 1) {
        const current = antiCrowdMatch.choices[0]
        const alt = ['1', 'X', '2'].filter(p => p !== current)
        antiCrowdMatch.choices.push(alt[0])
        antiCrowdMatch.diversified = true
        antiCrowdMatch.diversifyReason = (antiCrowdMatch.diversifyReason || '') + ` | 🔴 OBSTACLE CRITIQUE ${obs.avgScore}/5 — double forcé`
      }
    }
  }

  return grids;
}

/**
 * Generate a GOLD Coupon (6 doubles, 7 singles) from Promosport matches.
 * Uses entropy + crowd trap detection + ML confidence to pick the best 6 doubles
 * that cover surprises while keeping 7 safe singles as bankers.
 */
function generateGoldCoupon(enrichedMatches) {
  if (!enrichedMatches || enrichedMatches.length !== 13) return null

  // Rank matches: higher uncertainty → more likely to be a double
  const ranked = [...enrichedMatches]
    .map(m => ({
      ...m,
      uncertaintyScore: m.entropy + (m.isCrowdTrap ? 2.0 : 0) - (m.confidence / 100) * 0.5
    }))
    .sort((a, b) => b.uncertaintyScore - a.uncertaintyScore)

  // Top 6 uncertain → doubles, bottom 7 → singles
  const doubleMatches = ranked.slice(0, 6)
  const singleMatches = ranked.slice(6)

  function pickBestDouble(m) {
    const probs = [
      { v: '1', p: m.p1 },
      { v: 'X', p: m.px },
      { v: '2', p: m.p2 }
    ].sort((a, b) => b.p - a.p)

    // If crowd trap detected, double on the non-obvious side
    if (m.isCrowdTrap || m.isAwayCrowdTrap) {
      const crowdFav = m.crowdP1 > m.crowdP2 ? '1' : (m.crowdP2 > m.crowdP1 ? '2' : 'X')
      const remaining = probs.filter(x => x.v !== crowdFav).sort((a, b) => b.p - a.p)
      return [probs[0].v, remaining[0].v].sort(byOrder)
    }

    // If one outcome dominates (>60%), cover the other two
    if (probs[0].p > 0.60) {
      return [probs[1].v, probs[2].v].sort(byOrder)
    }

    // Best pair = highest + second highest prob
    return [probs[0].v, probs[1].v].sort(byOrder)
  }

  function pickBestSingle(m) {
    const probs = [
      { v: '1', p: m.p1 },
      { v: 'X', p: m.px },
      { v: '2', p: m.p2 }
    ].sort((a, b) => b.p - a.p)
    return [probs[0].v]
  }

  function byOrder(a, b) { return ({ '1': 0, 'X': 1, '2': 2 })[a] - ({ '1': 0, 'X': 1, '2': 2 })[b] }

  const matches = enrichedMatches.map(m => {
    const isDouble = doubleMatches.find(d => d.id === m.id)
    const choices = isDouble ? pickBestDouble(m) : pickBestSingle(m)
    return {
      id: m.id,
      home: m.homeTeam,
      away: m.awayTeam,
      type: isDouble ? 'DOUBLE' : 'SINGLE',
      choices,
      intel: m.intel,
      brief: m.tacticalBrief,
      entropy: m.entropy,
      confidence: m.confidence,
      isCrowdTrap: m.isCrowdTrap
    }
  })

  return {
    name: 'GOLD COUPON (6 DOUBLES)',
    matches,
    stats: {
      totalDoubles: 6,
      totalSingles: 7,
      coverageIndex: ((6 * 2 + 7) / 13 * 100).toFixed(0) + '%',
      avgConfidence: (enrichedMatches.reduce((acc, m) => acc + m.confidence, 0) / 13).toFixed(1),
      surprises: enrichedMatches.filter(m => m.isCrowdTrap).length
    }
  }
}

/**
 * Compute obstacle scores (1-5) for each match using available data.
 * Higher score = riskier match.
 */
function analyseObstacles(enrichedMatches) {
  return enrichedMatches.map(m => {
    const p1 = m.p1 || 0.33;
    const px = m.px || 0.33;
    const p2 = m.p2 || 0.34;

    // 1. Bookmaker: ML probability strength
    const bmScore = Math.max(p1, px, p2) > 0.45 ? 2 : 4;

    // 2. Terrain: generic (3 = neutral)
    const terrainScore = 3;

    // 3. Statistiques: entropy-based
    const H = -(p1 * Math.log2(Math.max(0.01, p1)) + px * Math.log2(Math.max(0.01, px)) + p2 * Math.log2(Math.max(0.01, p2)));
    const statsScore = H > 1.5 ? 4 : (H > 1.4 ? 3 : 2);

    // 4. Psychologie: high-pressure matches
    const psychoScore = m.isHighPressure ? 4 : 3;

    // 5. Public: crowd trap detection
    const crowdScore = m.isCrowdTrap || m.isAwayCrowdTrap ? 5 : (m.publicOverconfidence ? 4 : 2);

    // 6-9. Non-disponibles
    const unavailScore = 3;

    // 10. Average as placeholder for historique
    const histScore = 3;

    // 11. Valeur: EV-based
    const valueScore = m.publicOverconfidence ? 4 : 3;

    const scores = { bookmaker: bmScore, terrain: terrainScore, stats: statsScore, psycho: psychoScore, public: crowdScore, meteo: unavailScore, blessures: unavailScore, arbitrage: unavailScore, cotes: unavailScore, historique: histScore, valeur: valueScore };
    const avg = Object.values(scores).reduce((a, b) => a + b, 0) / 11;
    return { scores, avgScore: +avg.toFixed(2), maxScore: Math.max(...Object.values(scores)) };
  });
}

module.exports = { generatePromosportGrids, generateGoldCoupon };