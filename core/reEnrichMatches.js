require('dotenv').config()
const database = require('./database');
const EnrichedPredictionService = require('./enriched_predictions');
const logger = require('./logger');

const BATCH_LIMIT = parseInt(process.argv[2] || '50')
const TIMEOUT_MS = 30000

async function enrichWithTimeout(match, service) {
    return new Promise(async (resolve) => {
        const timer = setTimeout(() => {
            resolve(null)
        }, TIMEOUT_MS)
        try {
            const result = await service.fastEnrichMatch(match)
            clearTimeout(timer)
            resolve(result)
        } catch (err) {
            clearTimeout(timer)
            resolve(null)
        }
    })
}

async function reEnrich() {
    console.log(`🚀 [RE-ENRICH] Starting mass prediction update (batch: ${BATCH_LIMIT}, timeout: ${TIMEOUT_MS}ms)...`);
    const service = EnrichedPredictionService;
    
    try {
        const riskLabels = ['SAFE', 'STABLE', 'MODERATE', 'RISKY', 'RISKY BET', ''];
        const allMatches = await database.getAllMatches();
        const matches = allMatches.filter(m => 
            riskLabels.includes(m.prediction) || !m.prediction
        ).slice(0, BATCH_LIMIT);

        console.log(`📦 ${matches.length} matches to process (out of ${allMatches.length} total).`);

        let updatedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            process.stdout.write(`   [${i+1}/${matches.length}] ${match.homeTeam} vs ${match.awayTeam}... `);
            
            const enriched = await enrichWithTimeout(match, service);
            
            if (enriched && enriched.prediction) {
                try {
                    const evScore = enriched.quant?.ev_score || enriched.ev_score || 0;
                    const pick = enriched.prediction;
                    await database.updatePredictions(match.id, {
                        prediction: enriched.prediction,
                        verdict: enriched.verdict,
                        confidence: enriched.confidence,
                        expected_score: enriched.expected_score,
                        home_win_probability: enriched.home_win_probability,
                        draw_probability: enriched.draw_probability,
                        away_win_probability: enriched.away_win_probability,
                        ou_25_prob: enriched.ou_25_prob,
                        btts_prob: enriched.btts_prob,
                        ev_home: pick === '1' ? evScore : null,
                        ev_draw: pick === 'X' ? evScore : null,
                        ev_away: pick === '2' ? evScore : null,
                        enriched: enriched
                    });
                    updatedCount++;
                    console.log(`✅ ${enriched.prediction} (${Math.round(enriched.confidence)}%)`);
                } catch (err) {
                    errorCount++;
                    console.log(`❌ update failed`);
                }
            } else {
                errorCount++;
                console.log(`⏭️ no prediction`);
            }
        }

        console.log(`\n✅ [RE-ENRICH] Completed!`);
        console.log(`- Updated: ${updatedCount}`);
        console.log(`- Errors: ${errorCount}`);
        console.log(`- Total processed: ${matches.length}`);

    } catch (globalErr) {
        console.error(`💥 [RE-ENRICH] Critical Error: ${globalErr.message}`);
    } finally {
        process.exit(0);
    }
}

reEnrich();
