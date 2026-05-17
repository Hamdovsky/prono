/**
 * test_fpis_live_v3.js — Match Score Logic & Layer 6 Tests
 * ────────────────────────────────────────────────────────
 * 4 scenarios testing: Live Prob Shift, Confidence Injection,
 * Layer 6 Pressure Expansion (0-0), and Trend Alignment (0-2).
 */

'use strict';

const e = require('../services/FPISEngine');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
    if (condition) {
        console.log(`  ✅  ${label}`);
        passed++;
    } else {
        console.error(`  ❌  ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

// ─── SCENARIO 1: Live Prob Shift (Cardiff Met 1-0, min 65) ───────────────────
console.log('\n📋 SCENARIO 1: Live Prob Shift (Cardiff Met 1-0, Min 65)');
const s1 = e.processLive({
    homeTeam: 'Cardiff Met', awayTeam: 'Bala Town',
    minute: '65',
    scoreHome: 1, scoreAway: 0,
    shots_on_target_home: 4, shots_on_target_away: 2,
    dangerous_attacks_home: 35, dangerous_attacks_away: 20,
    corners_home: 4, corners_away: 2,
    home_win_probability: 45, draw_probability: 30, away_win_probability: 25,
    odds_home: 1.5, odds_home_open: 2.1
});
const homeP = parseFloat(s1.model_prediction.home);
console.log(`   Adjusted: ${s1.adjusted_prediction}`);
console.log(`   Home Prob: ${homeP}% (Base was 45%)`);
assert(s1.is_live, 'is_live flag set');
// Goal +1 => +25%, Time 65/90 => -7.2% => Net +17.8%
assert(homeP >= 60, `Live Prob Shift increased Home Prob above 60% (got ${homeP}%)`);

// ─── SCENARIO 2: Confidence Injection (Elite Signal) ─────────────────────────
console.log('\n📋 SCENARIO 2: Confidence Injection (Vaduz Domination)');
const s2 = e.processLive({
    homeTeam: 'Vaduz', awayTeam: 'Schaffhausen',
    minute: '75',
    scoreHome: 2, scoreAway: 0,
    shots_on_target_home: 8, shots_on_target_away: 1,
    dangerous_attacks_home: 60, dangerous_attacks_away: 15,
    corners_home: 8, corners_away: 1,
    home_win_probability: 75, draw_probability: 15, away_win_probability: 10,
    odds_home: 1.1, odds_home_open: 1.4, // Strong drift
    odds_drop_home: 0.3 // simulate strong liquidity
});
console.log(`   Confidence: ${s2.confidence}%`);
assert(s2.match_type === 'One-sided Domination', 'Match classified as Elite Signal');
assert(s2.confidence >= 70, `Confidence injected to > 70% (got ${s2.confidence}%)`);


// ─── SCENARIO 3: Layer 6 Pressure Expansion (0-0) ────────────────────────────
console.log('\n📋 SCENARIO 3: Layer 6 Pressure Expansion (0-0, high attacks)');
const s3 = e.processLive({
    homeTeam: 'Larne', awayTeam: 'Linfield',
    minute: '40',
    scoreHome: 0, scoreAway: 0,
    shots_on_target_home: 5, shots_on_target_away: 4,
    dangerous_attacks_home: 50, dangerous_attacks_away: 45, // High pressure: >1.2/min
    corners_home: 5, corners_away: 4,
    home_win_probability: 35, draw_probability: 35, away_win_probability: 30
});
console.log(`   Aggressive Angle: ${s3.alternative_angle?.[0]?.angle}`);
assert(s3.alternative_angle?.[0]?.angle === 'Over 0.5 Goals', 'Pressure Layer flagged Over 0.5 Goals for 0-0 match');

// ─── SCENARIO 4: Trend Alignment (0-2 deficit) ───────────────────────────────
console.log('\n📋 SCENARIO 4: Trend Alignment (Model favours Home, but Home is 0-2 down)');
const s4 = e.processLive({
    homeTeam: 'Colwyn Bay', awayTeam: 'The New Saints',
    minute: '55',
    scoreHome: 0, scoreAway: 2, // New Saints lead
    shots_on_target_home: 6, shots_on_target_away: 3,
    dangerous_attacks_home: 40, dangerous_attacks_away: 25,
    // Model originally favoured Home because of stats, but Home is severely losing
    home_win_probability: 55, draw_probability: 25, away_win_probability: 20
});
console.log(`   Adjusted Pred: ${s4.adjusted_prediction}`);
console.log(`   Away Prob: ${s4.model_prediction.away}`);
assert(s4.adjusted_prediction.includes('The New Saints Win'), 'Trend Alignment overrode model to favour leading team');
assert(parseFloat(s4.model_prediction.away) > 50, 'Trend Alignment forced away probability to reflect the 2-goal lead');

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(58)}`);
console.log(`  Live FPIS v3 Tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('  ✅ ALL V3 SCENARIOS PASSED — Match Score Logic active.\n');
    process.exit(0);
} else {
    console.log(`  ❌ ${failed} SCENARIO(S) FAILED.\n`);
    process.exit(1);
}
