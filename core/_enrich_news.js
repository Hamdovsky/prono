/**
 * _enrich_news.js — Batch news enricher with cache awareness.
 * Run manually:  node _enrich_news.js
 * Or triggered by: cron job in server.js (every 6h)
 */

const db         = require('./database');
const ep         = require('./enriched_predictions');
const newsService = require('../src/services/newsService');
const newsCache   = require('../src/services/newsCache');

const { calculateTacticalValue } = require('../src/services/TacticalValueEngine');

/**
 * Enrich one match with news intel (respects 2h cache).
 * @param {object} match
 * @param {boolean} forceRefresh — bypass cache
 */
async function enrichMatchNews(match, forceRefresh = false) {
    try {
        const intel = await newsService.getMatchIntelligence(
            match.id,
            match.homeTeam,
            match.awayTeam,
            match.startTimestamp || null,
            { forceRefresh }
        );

        const homeImpact = ep.calculateNewsScore(intel.home.headlines, intel.home.injuries);
        const awayImpact = ep.calculateNewsScore(intel.away.headlines, intel.away.injuries);

        const homeTotalImpact = homeImpact.score + ((intel.home.sentiment?.score || 0) * 10);
        const awayTotalImpact = awayImpact.score + ((intel.away.sentiment?.score || 0) * 10);

        const newsData = {
            home:      intel.home.headlines,
            away:      intel.away.headlines,
            injuries:  { home: intel.home.injuries, away: intel.away.injuries },
            lineups:   intel.lineups,
            confirmed: intel.confirmed,
            home_form_rating: intel.home_form_rating,
            away_form_rating: intel.away_form_rating,
            sentiment: {
                home_label: intel.home.sentiment?.label || 'Neutral',
                away_label: intel.away.sentiment?.label || 'Neutral'
            },
            impact: {
                home:     homeTotalImpact,
                away:     awayTotalImpact,
                home_att: homeImpact.attack,
                home_def: homeImpact.defense,
                away_att: awayImpact.attack,
                away_def: awayImpact.defense,
                critical: [...homeImpact.critical, ...awayImpact.critical]
            }
        };

        const news_impact = homeTotalImpact - awayTotalImpact;
        const prediction_logic = ep.generateStrategicReasoning(match, newsData);

        // 🚀 [NEW] Tactical Value Engine Integration
        // Calculate Adjusted EV based on news impact
        const baseProb = match.home_win_probability || 50;
        const odds = match.odds_home || 2.0;
        
        // Simple xG trend logic: if xG > 1.8, trend is UP
        const xgTrend = (match.home_xg > 1.8) ? 'UP' : 'STABLE';
        
        const tacticalValue = calculateTacticalValue(
            match.id,
            baseProb,
            news_impact,
            xgTrend,
            odds
        );

        await db.updatePredictions(match.id, {
            // Keep existing prediction values
            xgboost_prediction_data: match.xgboost_prediction_data,
            xgboost_confidence: match.xgboost_confidence,
            home_win_probability: match.home_win_probability,
            draw_probability: match.draw_probability,
            away_win_probability: match.away_win_probability,
            expected_score: match.expected_score,
            ou_25_prob: match.ou_25_prob,
            btts_prob: match.btts_prob,
            chaos_score: match.chaos_score,
            news_data: newsData,
            news_impact,
            // Persist Tactical EV results
            tactical_ev: tacticalValue.evPercentage,
            tactical_signal: tacticalValue.signal,
            adjusted_win_prob: tacticalValue.adjustedProb,
            kelly_criterion: tacticalValue.KellyCriterion,
            prediction_logic: prediction_logic
        });

        return { id: match.id, newsImpact: news_impact, tacticalValue };
    } catch (e) {
        console.error(`\n❌ Error for [${match.homeTeam} v ${match.awayTeam}]:`, e.message);
        return null;
    }
}

/**
 * Main batch run — processes all scheduled matches, skipping cached ones unless forceRefresh.
 * @param {boolean} forceRefresh
 */
async function run(forceRefresh = false) {
    console.log(`\n📰 [EnrichNews] Starting batch... ${forceRefresh ? '(FORCE REFRESH)' : '(cache-aware)'}`);
    console.log(`📦 [NewsCache] Stats:`, newsCache.stats());

    const matches = await db.getMatchesByStatus('scheduled');
    console.log(`📋 Found ${matches.length} scheduled matches.`);

    let enriched = 0, skipped = 0, errors = 0;
    const highImpact = [];

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const cacheKey = `match_intel_${m.id}_${m.homeTeam}_${m.awayTeam}`;

        // Check if already cache-fresh and not force-refresh
        if (!forceRefresh && newsCache.get(cacheKey)) {
            skipped++;
            continue;
        }

        const result = await enrichMatchNews(m, forceRefresh);
        if (result) {
            enriched++;
            if (result.newsImpact < -10 || result.newsImpact > 10) {
                highImpact.push({ match: `${m.homeTeam} vs ${m.awayTeam}`, impact: result.newsImpact, critical: result.critical });
            }
        } else {
            errors++;
        }

        process.stdout.write(i % 10 === 0 ? `\n[${i}/${matches.length}]` : '.');
    }

    console.log(`\n\n✅ Done — Enriched:${enriched} | Skipped(cache):${skipped} | Errors:${errors}`);

    if (highImpact.length > 0) {
        console.log(`\n⚠️  HIGH IMPACT MATCHES (|score| > 10):`);
        highImpact.forEach(h => console.log(`  ${h.match}: ${h.impact} [${h.critical.join(', ')}]`));
    }

    newsCache.sweep();
    return { enriched, skipped, errors, highImpact };
}

// Run directly if called from CLI
if (require.main === module) {
    const force = process.argv.includes('--force');
    run(force).then(() => process.exit(0));
}

module.exports = { run, enrichMatchNews };
