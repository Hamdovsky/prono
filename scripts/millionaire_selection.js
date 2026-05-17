/**
 * 💰 MILLIONAIRE SELECTION — Titanium Final
 * ─────────────────────────────────────────
 * Usage:
 *   node scripts/millionaire_selection.js          → demain
 *   node scripts/millionaire_selection.js --today  → aujourd'hui
 *   node scripts/millionaire_selection.js --both   → aujourd'hui + demain
 */
const Database = require('better-sqlite3');
const path = require('path');
const enrichedPredictions = require('../core/enriched_predictions');

const DB_PATH = path.resolve(__dirname, '../data/tactical.db');
const TODAY = process.argv.includes('--today');
const BOTH = process.argv.includes('--both');

function getDateRange(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const str = d.toISOString().split('T')[0];
    const ts0 = Math.floor(new Date(str + 'T00:00:00Z').getTime() / 1000);
    return { str, ts0, ts1: ts0 + 86400 };
}

function formatTime(ts) {
    if (!ts) return '--:--';
    return new Date(ts * 1000).toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca'
    });
}

function calcDynamics(enriched) {
    const conf = enriched.confidence || 0;
    return Math.min(99, Math.max(35, Math.round(conf * 100)));
}

function pickSmart(enriched, m) {
    // 1. Surgical Market (V80 prediction)
    let surgical = enriched.surgical_market || '';
    if (surgical && surgical !== 'N/A' && !surgical.includes('NO BET')) {
        return `💎 ${surgical}`;
    }

    // 2. Fallback to standard smart pick logic if no surgical market
    const winH = enriched.home_win_probability || 0;
    const winA = enriched.away_win_probability || 0;
    const p1X15 = enriched.p1X_O15_prob || 0;
    const pX215 = enriched.pX2_O15_prob || 0;

    if (p1X15 >= 65 && winH > winA) return `🛡️ 1X & +1.5`;
    if (pX215 >= 65 && winA > winH) return `🛡️ X2 & +1.5`;
    if (winH >= 68) return `🏠 1 (DOM)`;
    if (winA >= 68) return `✈️ 2 (EXT)`;

    return `⚡ But Mi-temps (+0.5 HT)`;
}

function buildMatchLine(m, enriched, label) {
    const time = formatTime(m.startTimestamp);
    const oddsH = m.odds_home || '—';
    const oddsA = m.odds_away || '—';
    const smartPick = pickSmart(enriched, m);
    const score = enriched.expected_score || '1 - 1';
    const parts = score.split(/\s*-\s*/);
    const total = (parseInt(parts[0]) || 0) + (parseInt(parts[1]) || 0);
    const tgLine = total >= 3 ? `+${total - 0.5}` : `-${(total + 0.5).toFixed(1).replace('.0', '')}`;
    const dynamics = calcDynamics(enriched);
    const ev = enriched.ev_home > enriched.ev_away ? enriched.ev_home : enriched.ev_away;

    return [
        `${time}[${oddsH}]${m.homeTeam} vs[${oddsA}]${m.awayTeam}`,
        smartPick,
        score,
        tgLine,
        `SAFE (EV: ${ev ? ev.toFixed(2) : '0.00'})`,
        `(${dynamics}%)`,
        `5`
    ].join('\n') + '\n';
}

async function runReport(db, offset, label) {
    const { str, ts0, ts1 } = getDateRange(offset);

    // Filter for matches where confidence is strictly populated and > 0
    const rawMatches = db.prepare(`
        SELECT * FROM matches
        WHERE (date(datetime(startTimestamp, 'unixepoch')) = ?
           OR startTimestamp BETWEEN ? AND ?)
        AND (status = 'scheduled' OR status IS NULL OR status = 'notstarted')
        AND confidence > 0
    `).all(str, ts0, ts1);

    if (rawMatches.length === 0) {
        console.log(`⚠️  Aucun match pour ${label} (${str}).`);
        return '';
    }

    console.log(`⚙️  Enrichissement et filtrage "MILLIONAIRE" de ${rawMatches.length} matchs (${label})...`);

    // Enrich all potential matches
    let enrichedList = [];
    for (const m of rawMatches) {
        try {
            const enriched = await enrichedPredictions.fastEnrichMatch(m);
            if (enriched && enriched.confidence > 0) {
                enrichedList.push({ match: m, enriched });
            }
        } catch (e) {
            // Ignore failed enrichment
        }
    }

    // 🔥 MILLIONAIRE SORTING ALGORITHM
    // We want highest confidence, highest EV, and least risk.
    enrichedList.sort((a, b) => {
        const confA = a.enriched.confidence || 0;
        const confB = b.enriched.confidence || 0;
        const evA = Math.max(a.enriched.ev_home || 0, a.enriched.ev_away || 0);
        const evB = Math.max(b.enriched.ev_home || 0, b.enriched.ev_away || 0);

        const scoreA = confA * 100 + (evA * 50);
        const scoreB = confB * 100 + (evB * 50);

        return scoreB - scoreA; // Descending
    });

    // Take Top 30
    const top30 = enrichedList.slice(0, 30);

    let report = `💰 <b>MILLIONAIRE SELECTION (${label}) (${top30.length})</b>\n`;
    report += `<b>MATCH</b>\n<b>SMART PICK 🎯</b>\n<b>CS (AI)</b>\n<b>TG (O/U)</b>\n<b>ACC%</b>\n<b>DYNAMICS</b>\n<b>MS</b>\n\n`;

    let rank = 1;
    for (const item of top30) {
        report += buildMatchLine(item.match, item.enriched, label) + '\n';

        // Call DeepSeek exclusively for the Top 3 selections to keep API consumption moderate
        if (rank <= 3) {
            try {
                const DeepSeekService = require('../services/DeepSeekService');
                if (DeepSeekService.isQuotaAvailable()) {
                    console.log(`🧠 [DEEPSEEK] Generating VIP pre-match preview for Top ${rank}: ${item.match.homeTeam} vs ${item.match.awayTeam}`);
                    const aiPreview = await DeepSeekService.analyzePreMatchVIP({
                        homeTeam: item.match.homeTeam,
                        awayTeam: item.match.awayTeam,
                        tournament_name: item.match.tournament_name || item.match.league || 'Ligue',
                        home_win_probability: item.enriched.home_win_probability || 0,
                        draw_probability: item.enriched.draw_probability || 0,
                        away_win_probability: item.enriched.away_win_probability || 0,
                        ou_25_prob: item.enriched.ou_25_prob || 0,
                        btts_prob: item.enriched.btts_prob || 0,
                        xgboost_confidence: item.enriched.confidence || 0,
                        home_position: item.match.home_position || 'N/A',
                        home_zone: item.match.home_zone || 'Mid-Table',
                        home_target_weight: item.match.home_target_weight || 0,
                        away_position: item.match.away_position || 'N/A',
                        away_zone: item.match.away_zone || 'Mid-Table',
                        away_target_weight: item.match.away_target_weight || 0
                    });

                    if (aiPreview) {
                        report += `   └─ 🧠 <b>VIP PRE-MATCH BRIEFING (DeepSeek V3) :</b>\n`;
                        report += `      • 📋 <i>Overview:</i> ${aiPreview.match_overview}\n`;
                        report += `      • ⚔️ <i>Key Tactical Matchup:</i> ${aiPreview.tactical_keyup}\n`;
                        report += `      • 🎯 <i>Score Estimé:</i> <b>${aiPreview.exact_score_prediction}</b> | 🛡️ <i>Sécurisation:</i> ${aiPreview.risk_mitigation}\n\n`;
                    }
                }
            } catch (dsErr) {
                console.error(`⚠️ [DEEPSEEK] VIP Analysis failed: ${dsErr.message}`);
            }
        }
        rank++;
    }

    return report;
}

async function main() {
    console.log('\n💰 TITANIUM — MILLIONAIRE SELECTION\n');
    const db = new Database(DB_PATH, { readonly: true });

    try {
        const offsets = BOTH ? [0, 1] : TODAY ? [0] : [1];
        const labels = { 0: 'TODAY', 1: 'TOMORROW' };

        for (const offset of offsets) {
            const report = await runReport(db, offset, labels[offset]);
            if (report) console.log(report);
        }
    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        db.close();
        process.exit(0);
    }
}

main();
