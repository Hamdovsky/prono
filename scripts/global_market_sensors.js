/**
 * 📊 GLOBAL MARKET SENSORS — Titanium Final
 * ──────────────────────────────────────────
 * Usage:
 *   node scripts/global_market_sensors.js          → demain
 *   node scripts/global_market_sensors.js --today  → aujourd'hui
 *   node scripts/global_market_sensors.js --both   → les deux
 */
const Database  = require('better-sqlite3');
const path      = require('path');
const enrichedPredictions = require('../core/enriched_predictions');

const DB_PATH = path.resolve(__dirname, '../data/tactical.db');
const TODAY   = process.argv.includes('--today');
const BOTH    = process.argv.includes('--both');

function getDateRange(offset = 0) {
    const d   = new Date();
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

function calcAccuracy(enriched) {
    const pw   = enriched.power_score        || 0;
    const conf = enriched.confidence         || 0;
    const formH= enriched.home_form_score    || 0;
    const formA= enriched.away_form_score    || 0;
    const base = (pw * 0.4) + (conf * 100 * 0.35) + ((formH + formA) / 2 * 100 * 0.25);
    return Math.min(99, Math.max(30, Math.round(base)));
}

function getRiskLabel(acc, enriched, m) {
    const sig  = m.motivation_signature || '';
    const conf = enriched.confidence || 0.5;
    if (sig.includes('ZONE MORTE') || sig.includes('COMPLAISANCE')) return `50%Risky`;
    if (acc >= 75 && conf >= 0.7) return `${acc}%Safe`;
    if (acc >= 60)                return `${acc}%`;
    return `${acc}%Risky`;
}

function buildPicks(enriched, m) {
    const winH   = enriched.home_win_probability || 0;
    const winA   = enriched.away_win_probability || 0;
    const draw   = enriched.draw_probability     || 0;
    const ou15   = enriched.ou_15_prob           || 0;
    const ou25   = enriched.ou_2_5_prob          || 50;
    const ou35   = enriched.ou_35_prob           || 0;
    const u15    = enriched.u_15_prob            || 0;
    const btts   = enriched.btts_prob            || 50;
    const ho25   = enriched.ho25_prob            || 0;
    const ggo25  = enriched.ggo25_prob           || 0;
    const p1X15  = enriched.p1X_O15_prob         || 0;
    const pX215  = enriched.pX2_O15_prob         || 0;
    const pHT05  = enriched.pHT05_prob           || 0;
    const dc1X   = enriched.dc_1X_prob           || 0;
    const dcX2   = enriched.dc_X2_prob           || 0;
    const dc12   = enriched.dc_12_prob           || 0;
    const hdcH   = enriched.hdc_h1_prob          || 0;
    const hdcA   = enriched.hdc_a1_prob          || 0;
    const bttsO15= enriched.btts_o15_prob        || 0;

    const picks = [];

    // Handicap
    if (hdcH >= 45) picks.push(`🏹 Hcp ${m.homeTeam} (-1) (${hdcH}%)`);
    if (hdcA >= 45) picks.push(`🏹 Hcp ${m.awayTeam} (-1) (${hdcA}%)`);

    // Combos premium
    if (ho25 >= 45)  picks.push(`🛡️ 1ETOVER2,5 (${ho25}%)`);
    if (ggo25 >= 50) picks.push(`🔥 GGandover2,5 (${ggo25}%)`);
    if (ggo25 >= 48) picks.push(`🔥 BTTS & Over2,5 (${ggo25}%)`);
    if (bttsO15 >= 65) picks.push(`🔥 BTTS & Over1,5 (${bttsO15}%)`);

    // 1X2 + ligne
    if (p1X15 >= 65 && winH > winA) picks.push(`🛡️ 1X & +1.5 (${p1X15}%)`);
    if (pX215 >= 65 && winA > winH) picks.push(`🛡️ X2 & +1.5 (${pX215}%)`);

    // Double Chance
    if (dc1X >= 78 && winH > draw) picks.push(`🟡 Double Chance 1X (${dc1X}%)`);
    if (dcX2 >= 78 && winA > draw) picks.push(`🟡 Double Chance X2 (${dcX2}%)`);
    if (dc12 >= 72)                picks.push(`🟡 Double Chance 12 (${dc12}%)`);

    // BTTS
    if (btts >= 62) picks.push(`⚽ BTTS (${btts}%)`);

    // Over/Under
    if (ou35 >= 42) picks.push(`📈 +3.5 buts (${ou35}%)`);
    if (ou25 >= 58) picks.push(`📈 +2.5 buts (${ou25}%)`);
    if (ou15 >= 78) picks.push(`📈 +1.5 buts (${ou15}%)`);
    if (u15  >= 55) picks.push(`📉 -1.5 buts (${u15}%)`);
    if (ou25 <= 35) picks.push(`📉 -2.5 buts`);

    // 1X2 direct
    if (winH >= 68) picks.push(`🏠 1 (DOM) (${winH}%)`);
    if (winA >= 68) picks.push(`✈️ 2 (EXT) (${winA}%)`);
    if (draw >= 38) picks.push(`🤝 X (NUL) (${draw}%)`);

    // Mi-temps
    if (pHT05 >= 65) picks.push(`⚡ But Mi-temps HT (${pHT05}%)`);

    // Fallback
    if (picks.length === 0) {
        if (winH > winA) picks.push(`🏠 1 (DOM) (${winH}%)`);
        else if (winA > winH) picks.push(`✈️ 2 (EXT) (${winA}%)`);
        else picks.push(`⚡ But Mi-temps (+0.5 HT)`);
    }

    return picks;
}

async function runReport(db, offset, label) {
    const { str, ts0, ts1 } = getDateRange(offset);

    const matches = db.prepare(`
        SELECT * FROM matches
        WHERE (date(datetime(startTimestamp, 'unixepoch')) = ?
           OR startTimestamp BETWEEN ? AND ?)
        AND (status = 'scheduled' OR status IS NULL OR status = 'notstarted')
        ORDER BY startTimestamp ASC
    `).all(str, ts0, ts1);

    if (matches.length === 0) {
        console.log(`⚠️  Aucun match pour ${label} (${str}).`);
        return '';
    }

    console.log(`⚙️  Enrichissement de ${matches.length} matchs (${label})...`);

    let report = `📊 <b>GLOBAL MARKET SENSORS (${label}) (${matches.length})</b>\n`;
    report    += `<b>MATCH</b>\n<b>SMART PICK 🎯</b>\n<b>CS (AI)</b>\n<b>TG (O/U)</b>\n<b>ACC%</b>\n<b>DYNAMICS</b>\n<b>MS</b>\n\n`;

    for (const m of matches) {
        try {
            const enriched  = await enrichedPredictions.fastEnrichMatch(m);
            const time      = formatTime(m.startTimestamp);
            const oddsH     = m.odds_home || '—';
            const oddsA     = m.odds_away || '—';
            const picks     = buildPicks(enriched, m);
            const score     = enriched.expected_score || '1 - 1';
            const parts     = score.split(/\s*-\s*/);
            const total     = (parseInt(parts[0]) || 0) + (parseInt(parts[1]) || 0);
            const tgLine    = total >= 3 ? `+${total - 0.5}` : `-${(total + 0.5).toFixed(1).replace('.0','')}`;
            const acc       = calcAccuracy(enriched);
            const risk      = getRiskLabel(acc, enriched, m);
            const dynamics  = calcDynamics(enriched);

            report += `${time}[${oddsH}]${m.homeTeam} vs[${oddsA}]${m.awayTeam}\n`;
            report += `${picks.join(' | ')}\n`;
            report += `${score}\n`;
            report += `${tgLine}\n`;
            report += `${risk}\n`;
            report += `(${dynamics}%)\n`;
            report += `5\n\n`;
        } catch(e) {
            console.warn(`  ⚠️ Skip ${m.homeTeam}: ${e.message}`);
        }
    }

    return report;
}

async function main() {
    console.log('\n📊 TITANIUM — GLOBAL MARKET SENSORS\n');
    const db = new Database(DB_PATH, { readonly: true });

    try {
        const offsets = BOTH ? [0, 1] : TODAY ? [0] : [1];
        const labels  = { 0: 'TODAY', 1: 'TOMORROW' };

        for (const offset of offsets) {
            const report = await runReport(db, offset, labels[offset]);
            if (report) console.log(report);
        }
    } catch(err) {
        console.error('❌ Error:', err.message);
    } finally {
        db.close();
        process.exit(0);
    }
}

main();
