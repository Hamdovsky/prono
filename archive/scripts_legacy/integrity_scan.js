/**
 * integrity_scan.js — Strategic Integrity Report Generator
 * ──────────────────────────────────────────────────────────
 * node scripts/integrity_scan.js
 */

const database = require('../database');
const IntegrityService = require('../services/integrity_service');
const { getLiveOdds } = require('../src/services/oddsService');
const { getBestPropsToday } = require('../services/playerPropsService');
const fs = require('fs');
const path = require('path');

async function runIntegrityScan() {
    console.log('🕵️‍♂️ Starting Global Integrity Scan (XGBoost Entropy)...');

    // 1. Fetch matches from the last 24h and upcoming 120h
    const matches = database.db.prepare(`
        SELECT * FROM matches 
        WHERE timestamp > datetime('now', '-24 hours')
          AND timestamp < datetime('now', '+120 hours')
    `).all();

    const highRiskMatches = [];
    const vaultMatches = [];
    const multiplierMatches = [];
    
    const BATCH_SIZE = 5; // Concurrency limit
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    console.log(`📡 Processing ${matches.length} matches in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < matches.length; i += BATCH_SIZE) {
        const batch = matches.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (match) => {
            try {
                let fullData = {};
                try { 
                    fullData = typeof match.fullData === 'string' ? JSON.parse(match.fullData) : (match.fullData || {}); 
                } catch(e) {}

                // 🔄 Stale Data Logic: Check if market_odds are missing or older than 30 mins
                const isMissing = !match.market_odds || match.market_odds === '{}';
                const lastUpdate = match.last_updated || 0;
                const isStale = (Date.now() - lastUpdate) > STALE_THRESHOLD_MS;

                if (isMissing || isStale) {
                    const liveOdds = await getLiveOdds(match.matchId || match.id);
                    if (liveOdds) {
                        match.market_odds = JSON.stringify(liveOdds);
                        // Update last_updated timestamp for this match (local in-memory for now)
                        match.last_updated = Date.now();
                    }
                }

                const modelProb = {
                    home_win_probability: match.home_win_probability || fullData.home_win_probability || 0,
                    draw_probability: match.draw_probability || fullData.draw_probability || 0,
                    away_win_probability: match.away_win_probability || fullData.away_win_probability || 0
                };

                const intelligence = fullData.intelligence || {};
                const audit = await IntegrityService.analyzeMatch(match, modelProb, intelligence);

                // Push to shared arrays (Memory usage optimized by not storing full objects where not needed)
                if (audit.strategicTags?.includes('CERTAINTY_VAULT')) vaultMatches.push({ match, audit });
                if (audit.strategicTags?.includes('GOLDEN_MULTIPLIER')) multiplierMatches.push({ match, audit });

                if (audit.isSuspicious || audit.score > 20) {
                    highRiskMatches.push({
                        match: `${match.homeTeam} vs ${match.awayTeam}`,
                        league: match.league,
                        type: audit.risks.map(r => r.tag).join(' | '),
                        score: audit.score,
                        recommendation: audit.recommendation
                    });
                }
            } catch (matchErr) {
                console.error(`❌ [ERROR] Failed to process match ${match.homeTeam}: ${matchErr.message}`);
            }
        }));

        process.stdout.write(`\r  ⚙️  Progress: ${Math.min(i + BATCH_SIZE, matches.length)}/${matches.length}`);
    }
    console.log('\n✅ Scan complete. Generating report...');

    // Report Generation
    const reportPath = path.join(__dirname, '../data/integrity_report.md');
    let md = `# 🛡️ Stitch Elite Strategic Scan Report (v4.5.1)\n\n`;

    md += `## 🟢 [THE CERTAINTY VAULT] — (Sure Wins)\n`;
    if (vaultMatches.length > 0) {
        md += `| المباراة | الخيار | الأودز | اليقين % | السبب الاستراتيجي |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;
        vaultMatches.forEach(({match, audit}) => {
            const odds = JSON.parse(match.market_odds || '{}').home || '-';
            md += `| ${match.homeTeam} vs ${match.awayTeam} | Home Win | ${odds} | ${match.home_win_probability}% | AI Mastery + Secure Market |\n`;
        });
    } else { md += `*No matches met the ultra-certainty criteria today.*\n`; }

    md += `\n## 🟡 [THE GOLDEN MULTIPLIER] — (Value Betting)\n`;
    if (multiplierMatches.length > 0) {
        md += `| المباراة | الأودز (B365) | السعر العادل | الربح الإضافي (Edge %) | النمط المكتشف |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;
        multiplierMatches.forEach(({match, audit}) => {
            const odds = JSON.parse(match.market_odds || '{}').home || '-';
            md += `| ${match.homeTeam} vs ${match.awayTeam} | ${odds} | ${audit.fairPrice} | +${Math.round(audit.edge*100)}% | ${audit.risks.find(r => r.tag==='INSIDERS_EDGE')? 'Insiders Edge' : 'Market Gap'} |\n`;
        });
    } else { md += `*No high-value multipliers detected currently.*\n`; }

    md += `\n## ⚽ [ELITE PLAYER PROPS] — (Strategic Shots & Cards)\n`;
    const bestProps = getBestPropsToday(15);
    if (bestProps.length > 0) {
        md += `| اللاعب | المباراة | النوع | اليقين % | الحالة |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;
        bestProps.forEach(p => {
            md += `| ${p.player_name} | ${p.homeTeam} vs ${p.awayTeam} | ${p.prop_type} | ${p.probability}% | ${p.status} |\n`;
        });
    } else { md += `*No elite player props available for the current selection.*\n`; }

    md += `\n## 🔴 [INTEGRITY ALERTS] — (Suspicious Patterns)\n`;
    if (highRiskMatches.length > 0) {
        md += `| [الدوري/المباراة] | [نوع الشبهة] | [XGB Recommendation] | [Integrity Score] |\n`;
        md += `| :--- | :--- | :--- | :--- |\n`;
        highRiskMatches.forEach(m => {
            md += `| ${m.match}<br>${m.league} | ${m.type} | **${m.recommendation}** | ${m.score} |\n`;
        });
    } else { md += `*Clean market. No major fraud patterns detected.*\n`; }

    fs.writeFileSync(reportPath, md);
    console.log(`\n💾 Detailed report saved to: ${reportPath}`);
}

runIntegrityScan().catch(console.error);
