/**
 * 💎 TOP ELITE SELECTION — Titanium Final
 * ─────────────────────────────────────────
 * Usage:
 *   node scripts/top_elite_selection.js          → demain
 *   node scripts/top_elite_selection.js --today  → aujourd'hui
 *   node scripts/top_elite_selection.js --both   → aujourd'hui + demain
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

function calcAccuracy(enriched) {
    // Combine multiple confidence signals into one ACC%
    const pw     = enriched.power_score        || 0;   // 0-100
    const conf   = enriched.confidence         || 0;   // 0-1
    const formH  = enriched.home_form_score    || 0;   // 0-1
    const formA  = enriched.away_form_score    || 0;   // 0-1
    const h2hAdv = enriched.h2h_advantage      || 0;   // -1 to 1

    const base   = (pw * 0.4) + (conf * 100 * 0.3) + ((formH + formA) / 2 * 100 * 0.2) + (Math.abs(h2hAdv) * 100 * 0.1);
    return Math.min(99, Math.max(30, Math.round(base)));
}

function calcDynamics(enriched) {
    const conf = enriched.confidence || 0;
    return Math.min(99, Math.max(35, Math.round(conf * 100)));
}

function pickSmart(enriched, m) {
    const winH   = enriched.home_win_probability || 0;
    const winA   = enriched.away_win_probability || 0;
    const draw   = enriched.draw_probability     || 0;
    const ou15   = enriched.ou_15_prob           || 0;
    const ou25   = enriched.ou_2_5_prob          || 0;
    const ou35   = enriched.ou_35_prob           || 0;
    const u15    = enriched.u_15_prob            || 0;
    const btts   = enriched.btts_prob            || 0;
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
    const bttsO25= ggo25;

    // ── PRIORITÉ 1 : Handicap fort (domination absolue) ──
    if (hdcH >= 45) return `🏹 Hcp ${m.homeTeam} (-1)`;
    if (hdcA >= 45) return `🏹 Hcp ${m.awayTeam} (-1)`;

    // ── PRIORITÉ 2 : Combos haut de gamme ──
    if (ho25 >= 45)                  return `🛡️ 1ETOVER2,5`;
    if (ggo25 >= 50)                 return `🔥 GGandover2,5`;
    if (bttsO25 >= 48)               return `🔥 BTTS & Over2,5`;
    if (bttsO15 >= 65)               return `🔥 BTTS & Over1,5`;

    // ── PRIORITÉ 3 : Combos 1X2 + ligne ──
    if (p1X15 >= 65 && winH > winA)  return `🛡️ 1X & +1.5`;
    if (pX215 >= 65 && winA > winH)  return `🛡️ X2 & +1.5`;

    // ── PRIORITÉ 4 : Double Chance ──
    if (dc1X >= 78 && winH > draw)   return `🟡 Double Chance 1X`;
    if (dcX2 >= 78 && winA > draw)   return `🟡 Double Chance X2`;
    if (dc12 >= 72)                  return `🟡 Double Chance 12`;

    // ── PRIORITÉ 5 : 1X2 direct ──
    if (winH >= 68)                  return `🏠 1 (DOM)`;
    if (winA >= 68)                  return `✈️ 2 (EXT)`;
    if (draw >= 38)                  return `🤝 X (NUL)`;

    // ── PRIORITÉ 6 : Over/Under ──
    if (ou35 >= 42)                  return `📈 +3.5 buts (Over)`;
    if (ou25 >= 58)                  return `📈 +2.5 buts (Over)`;
    if (ou15 >= 78)                  return `📈 +1.5 buts (Over)`;
    if (u15  >= 55)                  return `📉 -1.5 buts (Under)`;
    if (ou25 <= 35)                  return `📉 -2.5 buts (Under)`;

    // ── PRIORITÉ 7 : BTTS ──
    if (btts >= 62)                  return `⚽ Les 2 Marquent (BTTS)`;

    // ── PRIORITÉ 8 : Mi-temps ──
    if (pHT05 >= 65)                 return `⚡ But Mi-temps (+0.5 HT)`;

    // Fallback
    if (winH > winA)                 return `🏠 1 (DOM)`;
    return `⚡ But Mi-temps (+0.5 HT)`;
}

function getRiskLabel(enriched, m) {
    const sig = m.motivation_signature || '';
    const conf = enriched.confidence || 0.5;
    const acc  = calcAccuracy(enriched);

    if (sig.includes('ZONE MORTE') || sig.includes('COMPLAISANCE')) return `50%Risky`;
    if (acc >= 75 && conf >= 0.7) return `${acc}%Safe`;
    if (acc >= 60)                return `${acc}%`;
    return `${acc}%Risky`;
}

function buildMatchLine(m, enriched, label) {
    const time      = formatTime(m.startTimestamp);
    const oddsH     = m.odds_home || '—';
    const oddsA     = m.odds_away || '—';
    const smartPick = pickSmart(enriched, m);
    const score     = enriched.expected_score || '1 - 1';
    const parts     = score.split(/\s*-\s*/);
    const total     = (parseInt(parts[0]) || 0) + (parseInt(parts[1]) || 0);
    const tgLine    = total >= 3 ? `+${total - 0.5}` : `-${(total + 0.5).toFixed(1).replace('.0','')}`;
    const riskLabel = getRiskLabel(enriched, m);
    const dynamics  = calcDynamics(enriched);

    return [
        `${time}[${oddsH}]${m.homeTeam} vs[${oddsA}]${m.awayTeam}`,
        smartPick,
        score,
        tgLine,
        riskLabel,
        `(${dynamics}%)`,
        `5`
    ].join('\n') + '\n';
}

async function runReport(db, offset, label) {
    const { str, ts0, ts1 } = getDateRange(offset);

    const matches = db.prepare(`
        SELECT * FROM matches
        WHERE (date(datetime(startTimestamp, 'unixepoch')) = ?
           OR startTimestamp BETWEEN ? AND ?)
        AND (status = 'scheduled' OR status IS NULL OR status = 'notstarted')
        ORDER BY startTimestamp ASC
        LIMIT 20
    `).all(str, ts0, ts1);

    if (matches.length === 0) {
        console.log(`⚠️  Aucun match pour ${label} (${str}).`);
        return '';
    }

    console.log(`⚙️  Enrichissement de ${matches.length} matchs (${label})...`);

    let report = `💎 <b>TOP ELITE SELECTION (${label}) (${matches.length})</b>\n`;
    report    += `<b>MATCH</b>\n<b>SMART PICK 🎯</b>\n<b>CS (AI)</b>\n<b>TG (O/U)</b>\n<b>ACC%</b>\n<b>DYNAMICS</b>\n<b>MS</b>\n\n`;

    for (const m of matches) {
        try {
            const enriched = await enrichedPredictions.fastEnrichMatch(m);
            report += buildMatchLine(m, enriched, label) + '\n';
        } catch(e) {
            console.warn(`  ⚠️ Skip ${m.homeTeam}: ${e.message}`);
        }
    }

    return report;
}

async function main() {
    console.log('\n💎 TITANIUM — TOP ELITE SELECTION\n');
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
