/**
 * today_analysis.js — Nightly Prediction Accuracy Module (V2)
 * ─────────────────────────────────────────────────────────────
 * Can be run directly: node today_analysis.js [YYYY-MM-DD]
 * Or imported and called as a module: runAnalysis(date)
 * Stores results to data/accuracy_log.json
 * 
 * V2 Improvements:
 *   - Multi-market tracking: 1X2, Over/Under 2.5, BTTS
 *   - Confidence-band analysis (>85%, 60-85%, <60%)
 *   - Flat-bet ROI simulation (+1 hit, -1 miss)
 *   - Streak tracking (current & record consecutive hits)
 */

const path = require('path');
const fs   = require('fs');
const database = require('../core/database');

const ACCURACY_LOG = path.join(__dirname, '..', 'data', 'accuracy_log.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadAccuracyLog() {
    if (fs.existsSync(ACCURACY_LOG)) {
        try { 
            const data = JSON.parse(fs.readFileSync(ACCURACY_LOG, 'utf8'));
            if (data && Array.isArray(data.entries)) return data; 
        }
        catch (_) {}
    }
    return { entries: [], lastUpdated: null, recordStreak: 0 };
}

function saveAccuracyLog(log) {
    fs.mkdirSync(path.dirname(ACCURACY_LOG), { recursive: true });
    fs.writeFileSync(ACCURACY_LOG, JSON.stringify(log, null, 2));
}

function getPredictedOutcome(match) {
    const home = parseFloat(match.home_win_probability || 0);
    const draw = parseFloat(match.draw_probability    || 0);
    const away = parseFloat(match.away_win_probability || 0);
    if (home >= draw && home >= away) return 'HOME';
    if (away >= draw && away >  home) return 'AWAY';
    return 'DRAW';
}

function getActualOutcome(match) {
    const h = parseInt(match.scoreHome ?? -1);
    const a = parseInt(match.scoreAway ?? -1);
    if (h < 0 || a < 0) return null;
    if (h > a) return 'HOME';
    if (a > h) return 'AWAY';
    return 'DRAW';
}

// Over/Under 2.5
function getActualOU25(match) {
    const h = parseInt(match.scoreHome ?? -1);
    const a = parseInt(match.scoreAway ?? -1);
    if (h < 0 || a < 0) return null;
    return (h + a) > 2.5 ? 'OVER' : 'UNDER';
}
function getPredictedOU25(match) {
    const prob = parseFloat(match.ou_25_prob || 0);
    if (!prob) return null;
    return prob > 50 ? 'OVER' : 'UNDER';
}

// BTTS
function getActualBTTS(match) {
    const h = parseInt(match.scoreHome ?? -1);
    const a = parseInt(match.scoreAway ?? -1);
    if (h < 0 || a < 0) return null;
    return (h > 0 && a > 0) ? 'YES' : 'NO';
}
function getPredictedBTTS(match) {
    const prob = parseFloat(match.btts_prob || 0);
    if (!prob) return null;
    return prob > 50 ? 'YES' : 'NO';
}

// Confidence level categorizer
function getConfBand(conf) {
    const c = parseFloat(conf || 0);
    if (c >= 0.85 || c >= 85) return 'HIGH';   // > 85%
    if (c >= 0.60 || c >= 60) return 'MED';    // 60–85%
    return 'LOW';                               // < 60%
}

// ── Streak Calculator ─────────────────────────────────────────────────────────

function computeStreaks(entries) {
    let currentStreak = 0;
    let recordStreak = 0;
    let tempStreak = 0;

    // entries are newest-first; we need oldest-first for streak
    const sorted = [...entries].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    for (const e of sorted) {
        if (e.accuracy !== null && e.accuracy >= 50) {
            tempStreak++;
            if (tempStreak > recordStreak) recordStreak = tempStreak;
        } else {
            tempStreak = 0;
        }
    }
    currentStreak = tempStreak;
    return { currentStreak, recordStreak };
}

// ── Main Analysis Function ────────────────────────────────────────────────────

async function runAnalysis(dateStr) {
    const date = dateStr || new Date().toISOString().split('T')[0];
    const timestampStart = new Date(date).getTime();
    const timestampEnd = timestampStart + (24 * 60 * 60 * 1000) - 1;

    console.log(`\n📊 [Analysis V2] Running for date: ${date}`);

    let matches;
    try {
        matches = await database.prepare(`
            SELECT id AS matchId, homeTeam, awayTeam, league, timestamp,
                   scoreHome, scoreAway, status,
                   home_win_probability, draw_probability, away_win_probability,
                   xgboost_confidence, ou_25_prob, btts_prob
            FROM matches
            WHERE (
              (timestamp LIKE ?) OR 
              (CAST(timestamp AS INTEGER) >= ? AND CAST(timestamp AS INTEGER) <= ?)
            )
            AND status IN ('FT', 'Finished', 'finished', 'AET', 'PEN', 'Ended', 'ended')
        `).all(`%${date}%`, timestampStart, timestampEnd);
    } catch (e) {
        console.error('[Analysis] DB Query failed:', e.message);
        return null;
    }

    if (!matches || matches.length === 0) {
        console.log(`[Analysis] No matches found for ${date}`);
        return { date, hits: 0, misses: 0, pending: 0, total: 0, accuracy: null };
    }

    // ── Counters ─────────────────────────────────────────────────────────────
    let hits = 0, misses = 0, pending = 0;
    let ou_hits = 0, ou_misses = 0;
    let btts_hits = 0, btts_misses = 0;
    let roi = 0;
    const missed = [];
    const byLeague = {};

    // Confidence bands: { HIGH: {hits, misses}, MED, LOW }
    const confBands = { HIGH: { hits: 0, misses: 0 }, MED: { hits: 0, misses: 0 }, LOW: { hits: 0, misses: 0 } };

    for (const m of matches) {
        const predicted = getPredictedOutcome(m);
        const actual    = getActualOutcome(m);

        if (!actual) { pending++; continue; }

        // Per-league tracking
        const lg = m.league || 'Unknown';
        if (!byLeague[lg]) byLeague[lg] = { hits: 0, misses: 0 };

        // 1X2 accuracy
        const band = getConfBand(m.xgboost_confidence);
        if (predicted === actual) {
            hits++;
            byLeague[lg].hits++;
            confBands[band].hits++;
            roi += 1;
        } else {
            misses++;
            byLeague[lg].misses++;
            confBands[band].misses++;
            roi -= 1;
            missed.push({
                matchId:   m.matchId,
                match:     `${m.homeTeam} vs ${m.awayTeam}`,
                league:    m.league,
                predicted,
                actual,
                score:     `${m.scoreHome}-${m.scoreAway}`,
                xgbConf:   m.xgboost_confidence,
                homeP:     m.home_win_probability,
                drawP:     m.draw_probability,
                awayP:     m.away_win_probability,
            });
        }

        // O/U 2.5 accuracy
        const predOU  = getPredictedOU25(m);
        const actlOU  = getActualOU25(m);
        if (predOU && actlOU) {
            if (predOU === actlOU) ou_hits++;
            else ou_misses++;
        }

        // BTTS accuracy
        const predBTTS = getPredictedBTTS(m);
        const actlBTTS = getActualBTTS(m);
        if (predBTTS && actlBTTS) {
            if (predBTTS === actlBTTS) btts_hits++;
            else btts_misses++;
        }
    }

    const total    = hits + misses;
    const accuracy = total > 0 ? parseFloat(((hits / total) * 100).toFixed(1)) : null;
    const ou_total = ou_hits + ou_misses;
    const btts_total = btts_hits + btts_misses;

    // Build league table
    const leagueTable = Object.entries(byLeague).map(([league, d]) => ({
        league,
        hits: d.hits,
        misses: d.misses,
        total: d.hits + d.misses,
        accuracy: d.hits + d.misses > 0 ? parseFloat(((d.hits / (d.hits + d.misses)) * 100).toFixed(1)) : null
    })).sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0));

    // Confidence band accuracy
    const confidenceBands = {
        HIGH: {
            label: '> 85% ثقة',
            hits: confBands.HIGH.hits,
            misses: confBands.HIGH.misses,
            accuracy: (confBands.HIGH.hits + confBands.HIGH.misses) > 0
                ? parseFloat(((confBands.HIGH.hits / (confBands.HIGH.hits + confBands.HIGH.misses)) * 100).toFixed(1))
                : null
        },
        MED: {
            label: '60–85% ثقة',
            hits: confBands.MED.hits,
            misses: confBands.MED.misses,
            accuracy: (confBands.MED.hits + confBands.MED.misses) > 0
                ? parseFloat(((confBands.MED.hits / (confBands.MED.hits + confBands.MED.misses)) * 100).toFixed(1))
                : null
        },
        LOW: {
            label: '< 60% ثقة',
            hits: confBands.LOW.hits,
            misses: confBands.LOW.misses,
            accuracy: (confBands.LOW.hits + confBands.LOW.misses) > 0
                ? parseFloat(((confBands.LOW.hits / (confBands.LOW.hits + confBands.LOW.misses)) * 100).toFixed(1))
                : null
        }
    };

    const result = {
        date,
        hits,
        misses,
        pending,
        total,
        accuracy,
        roi,
        markets: {
            ou25: {
                hits: ou_hits,
                misses: ou_misses,
                total: ou_total,
                accuracy: ou_total > 0 ? parseFloat(((ou_hits / ou_total) * 100).toFixed(1)) : null
            },
            btts: {
                hits: btts_hits,
                misses: btts_misses,
                total: btts_total,
                accuracy: btts_total > 0 ? parseFloat(((btts_hits / btts_total) * 100).toFixed(1)) : null
            }
        },
        confidenceBands,
        leagueTable,
        missedPredictions: missed,
        generatedAt: new Date().toISOString()
    };

    // Save to log & update streaks + cumulative ROI
    const log = loadAccuracyLog();
    log.entries = log.entries.filter(e => e.date !== date);
    log.entries.unshift(result);
    if (log.entries.length > 90) log.entries = log.entries.slice(0, 90);
    log.lastUpdated = result.generatedAt;

    // Streak tracking
    const { currentStreak, recordStreak } = computeStreaks(log.entries);
    log.currentStreak = currentStreak;
    log.recordStreak  = Math.max(recordStreak, log.recordStreak || 0);

    // Cumulative ROI calculation (Oldest to Newest)
    let cumulative = 0;
    const chronologically = [...log.entries].reverse();
    chronologically.forEach(e => {
        cumulative += (e.roi || 0);
        e.cumulativeRoi = parseFloat(cumulative.toFixed(2));
    });

    saveAccuracyLog(log);

    // ── Console Summary ───────────────────────────────────────────────────────
    console.log(`\n╔══════════════════════════════════════════════════`);
    console.log(`║ 📊 PRECISION ANALYSIS V2 — ${date}`);
    console.log(`╠══════════════════════════════════════════════════`);
    console.log(`║  ✅ 1X2 Accuracy : ${accuracy !== null ? accuracy + '%' : 'N/A'} (${hits}/${total})`);
    console.log(`║  ⚽ O/U 2.5     : ${result.markets.ou25.accuracy !== null ? result.markets.ou25.accuracy + '%' : 'N/A'} (${ou_hits}/${ou_total})`);
    console.log(`║  🤝 BTTS        : ${result.markets.btts.accuracy !== null ? result.markets.btts.accuracy + '%' : 'N/A'} (${btts_hits}/${btts_total})`);
    console.log(`║  💰 ROI (flat)  : ${roi >= 0 ? '+' : ''}${roi} وحدة`);
    console.log(`║  🔥 Streak      : ${currentStreak} | Record: ${log.recordStreak}`);
    console.log(`║  ⏳ Pending     : ${pending}`);
    console.log(`╚══════════════════════════════════════════════════\n`);

    if (missed.length > 0) {
        console.log('❌ MISSED PREDICTIONS:');
        for (const m of missed) {
            console.log(`  • ${m.match} [${m.league}]`);
            console.log(`    Score: ${m.score} | Predicted: ${m.predicted} | Actual: ${m.actual}`);
            console.log(`    Probs  H:${m.homeP} D:${m.drawP} A:${m.awayP} XGB:${m.xgbConf}`);
        }
    }

    return result;
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
    const dateArg = process.argv[2];
    runAnalysis(dateArg).then(() => process.exit(0)).catch(e => {
        console.error('Analysis failed:', e);
        process.exit(1);
    });
}

module.exports = { runAnalysis, loadAccuracyLog };

