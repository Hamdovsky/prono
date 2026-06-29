const logger = require('./logger');
const mlPredictionService = require('../services/mlPredictionService');
const doubleOptimizer = require('../services/doubleOptimizerService');
const db = require('./database');


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

async function generatePromosportGrids(scrapedMatches) {
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
            const pred = await mlPredictionService.getMLPrediction(bestMatchData).catch(e => {
                logger.warn(`⚠️ [PROMOSPORT-ENGINE] Prediction failed for ${m.homeTeam}: ${e.message}`);
                return {};
            }) || {};
          
            let p1 = pred.probabilities?.home || m.homeWinProbability || null;
            let px = pred.probabilities?.draw || m.drawProbability || null;
            let p2 = pred.probabilities?.away || m.awayWinProbability || null;
          
            if (p1 === null || px === null || p2 === null) {
                return { ...m, p1: null, px: null, p2: null, entropy: null, confidence: null, hasData: false, tacticalBrief: 'Prédiction ML indisponible — pas assez de données.' }
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
    const result = generateGridsWithStrategicCoverage(enrichedMatches);
    return result;
  } catch (err) {
    logger.error('[PROMOSPORT-ENGINE] Grid generation failed:', err.message);
    throw err;
  }
}

/**
 * Advanced Strategic Coverage: Ensures the 4 grids complement each other.
 */
function generateGridsWithStrategicCoverage(enrichedMatches) {
  const gridConfigs = [
    { id: 'T1', name: 'TITANIUM AI (OPTIMIZED)', doubles: 5, bias: 'fav' },
    { id: 'T2', name: 'EXPERT VALUE (DRAW BIAS)', doubles: 4, bias: 'draw' },
    { id: 'T3', name: 'SECURITY (BANKER FOCUS)', doubles: 3, bias: 'safe' },
    { id: 'T4', name: 'COVERAGE (ANTI-CROWD)', doubles: 3, bias: 'upset' }
  ];

  const grids = [];

  const optimalDoubles = doubleOptimizer.selectOptimalDoubles(enrichedMatches, 13)

  gridConfigs.forEach((config, gridIdx) => {
    let doubleIds
    if (config.bias === 'safe') {
      doubleIds = optimalDoubles.ranked.filter(m => m.bestSingle.prob >= 0.75).slice(0, config.doubles).map(m => m.id)
      if (doubleIds.length < config.doubles) {
        const extra = optimalDoubles.ranked.filter(m => !doubleIds.includes(m.id)).slice(0, config.doubles - doubleIds.length).map(m => m.id)
        doubleIds = [...doubleIds, ...extra]
      }
    } else if (config.bias === 'draw') {
      const drawCandidates = optimalDoubles.ranked.filter(m => m.px > 0.28 && m.gain > 0.20)
      doubleIds = drawCandidates.slice(0, config.doubles).map(m => m.id)
      if (doubleIds.length < config.doubles) {
        const extra = optimalDoubles.ranked.filter(m => !doubleIds.includes(m.id)).slice(0, config.doubles - doubleIds.length).map(m => m.id)
        doubleIds = [...doubleIds, ...extra]
      }
    } else if (config.bias === 'upset') {
      const upsetCandidates = optimalDoubles.ranked.filter(m => m.isCrowdTrap || m.isContrarian)
      doubleIds = upsetCandidates.slice(0, config.doubles).map(m => m.id)
      if (doubleIds.length < config.doubles) {
        const extra = optimalDoubles.ranked.filter(m => !doubleIds.includes(m.id)).sort((a, b) => b.gain - a.gain).slice(0, config.doubles - doubleIds.length).map(m => m.id)
        doubleIds = [...doubleIds, ...extra]
      }
    } else {
      doubleIds = optimalDoubles.ranked.slice(0, config.doubles).map(m => m.id)
    }

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

  // DIVERSIFICATION PASS — Anti-piège public
  // Quand les 4 grilles donnent le même pick pour un match ET que le public
  // est trop confiant sur ce résultat, on force T4 (anti-crowd) à diverger
  for (let mi = 0; mi < 13; mi++) {
    const picksStr = grids.map(g => [...g.matches[mi].choices].sort().join(''))
    const unique = [...new Set(picksStr)]

    if (unique.length === 1 && unique[0].length === 1) {
      const currentPick = unique[0]
      const m = enrichedMatches[mi]

      const crowdP = currentPick === '1' ? (m.crowdP1 || m.homeWinProbability || 0)
                   : currentPick === '2' ? (m.crowdP2 || m.awayWinProbability || 0)
                   : (m.drawProbability || 0)
      const total = (m.homeWinProbability || 0.33) + (m.drawProbability || 0.33) + (m.awayWinProbability || 0.34)
      const crowdPct = total > 0 ? crowdP / total : 0

      const forceDiversify = (
        crowdPct > 0.50 ||
        m.publicOverconfidence ||
        m.isCrowdTrap ||
        m.isAwayCrowdTrap
      )

      if (forceDiversify) {
        const alternatives = ['1', 'X', '2'].filter(p => p !== currentPick)
        const mlProbs = { '1': m.p1 || 0.33, 'X': m.px || 0.33, '2': m.p2 || 0.34 }
        alternatives.sort((a, b) => mlProbs[b] - mlProbs[a])

        // Changer T4 (anti-crowd, index 3)
        const gi = 3
        const targetMatch = grids[gi].matches[mi]
        targetMatch.choices = [alternatives[0]]
        targetMatch.diversified = true
        const reason = `🛡️ ANTI-PIÈGE PUBLIC: foule ${(crowdPct*100).toFixed(0)}% sur ${currentPick}, nous prenons ${alternatives[0]}`
        targetMatch.diversifyReason = reason
        targetMatch.brief = (targetMatch.brief || '') + ' | ' + reason
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

module.exports = { generatePromosportGrids, generateGoldCoupon };