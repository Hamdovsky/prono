const logger = require('./logger');
const mlPredictionService = require('../services/mlPredictionService');
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
    // Convert to [0, 1) using unsigned right shift
    return ((hash >>> 0) % 10000) / 10000;
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
          
            const p1 = pred.probabilities?.home || m.homeWinProbability || 0.33;
            const px = pred.probabilities?.draw || m.drawProbability || 0.33;
            const p2 = pred.probabilities?.away || m.awayWinProbability || 0.34;
          
            const H = - (p1 * Math.log2(Math.max(0.01, p1)) + px * Math.log2(Math.max(0.01, px)) + p2 * Math.log2(Math.max(0.01, p2)));
          
            const isHighPressure = dbMatch?.is_high_pressure || (m.intel?.motivation > 85);
            const pressureMultiplier = isHighPressure ? 1.12 : 1.0;
            const confidence = pred.confidence || Math.max(50, 80 - (H * 15));

            const crowdP1 = m.homeWinProbability || 0.33;
            const p1Delta = crowdP1 - p1;
            const isCrowdTrap = (p1Delta > 0.25 && p1 < 0.50);

            return {
                ...m,
                p1: Math.min(0.95, p1 * pressureMultiplier),
                px, p2,
                entropy: H,
                confidence: confidence,
                isHighPressure,
                isCrowdTrap,
                intel: pred.intel || {
                    form: 60 + seededRand(`${m.homeTeam}_form`) * 20,
                    logistics: 70 + seededRand(`${m.awayTeam}_logistics`) * 10,
                    motivation: isHighPressure ? 95 : 75,
                    sharp: confidence
                },
                tacticalBrief: isCrowdTrap 
                    ? `🚨 ALERTE PIÈGE : Le public surestime ${m.homeTeam}.`
                    : (pred.brief || (isHighPressure ? '⚠️ MATCH À HAUTE PRESSION.' : 'Analyse basée sur les probabilités de base.'))
            };
        } catch (e) {
            logger.error(`❌ [PROMOSPORT-ENGINE] Failed to enrich match ${m.homeTeam}:`, e.message);
            // Return minimal fallback for this match to keep the grid intact
            return { ...m, p1: 0.33, px: 0.33, p2: 0.34, entropy: 1.5, confidence: 50, intel: { form: 50, logistics: 50, motivation: 50, sharp: 50 }, tacticalBrief: 'Enrichment failed.' };
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

  gridConfigs.forEach((config, gridIdx) => {
    // Strategic Double Selection: Focus on tough matches but rotate which ones we cover
    // and ALWAYS include Crowd Traps in the selection.
    const doubleIds = [...enrichedMatches]
        .sort((a, b) => {
            // Crowd Traps get a massive priority boost for doubles
            const trapBoostA = a.isCrowdTrap ? 10 : 0;
            const trapBoostB = b.isCrowdTrap ? 10 : 0;
            
            const rotationBias = (Math.sin(gridIdx + (a.id * 0.7)) * 0.4);
            return (b.entropy + trapBoostB + rotationBias) - (a.entropy + trapBoostA);
        })
        .slice(0, config.doubles)
        .map(m => m.id);

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

  return grids;
}

module.exports = { generatePromosportGrids };