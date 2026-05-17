/**
 * test_fpis_live_v4.js — Live Data Integrity & Deadlock Fixes (V4)
 * ────────────────────────────────────────────────────────
 * 4 urgent fixes validations: 
 * 1. Score-Triggered Prob Shift (min 68%)
 * 2. 0-2 Corrective Trend Logic (One-sided Domination, Leader/O2.5)
 * 3. Validation Check (live_score != last_cached_score -> _recalc_triggered)
 * 4. Confidence Deadlock Fix (Min 25% if min>10)
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

// ─── SCENARIO 1: Score-Triggered Prob Shift (Min 68%) ─────────────────────────
console.log('\n📋 SCENARIO 1: Score-Triggered Prob Shift (Cardiff Met 1-0)');
const s1 = e.processLive({
    id: 9001,
    homeTeam: 'Cardiff Met', awayTeam: 'Bala Town',
    minute: '45',
    scoreHome: 1, scoreAway: 0,
    shots_on_target_home: 2, shots_on_target_away: 2,
    home_win_probability: 30, draw_probability: 35, away_win_probability: 35
});
const homeP = parseFloat(s1.model_prediction.home);
console.log(`   Home Prob: ${homeP}% (Base was 30%)`);
assert(homeP >= 68, `Leading team probability forced to minimum 68% (got ${homeP}%)`);

// ─── SCENARIO 2: Corrective Trend Logic (0-2 Deficit) ─────────────────────────
console.log('\n📋 SCENARIO 2: Corrective Trend Logic (The New Saints 0-2 down)');
const s2 = e.processLive({
    id: 9002,
    homeTeam: 'Colwyn Bay', awayTeam: 'The New Saints',
    minute: '65',
    scoreHome: 0, scoreAway: 2,
    home_win_probability: 55, draw_probability: 25, away_win_probability: 20
});
console.log(`   Match Type: ${s2.match_type}`);
console.log(`   Adjusted Pred: ${s2.adjusted_prediction}`);
assert(s2.match_type === 'One-sided Domination', `Match type is 'One-sided Domination'`);
assert(s2.adjusted_prediction.includes('The New Saints Win / Over 2.5 Goals'), `Prediction pivoted to leading team ('The New Saints Win / Over 2.5 Goals')`);

// ─── SCENARIO 3: Validation Check & Recalc ────────────────────────────────────
console.log('\n📋 SCENARIO 3: Validation Check (Live Score Cache Bypass)');
// Initial call -> Score is 0-0
e.processLive({ id: 9003, homeTeam: 'A', awayTeam: 'B', minute: '10', scoreHome: 0, scoreAway: 0 });
// Second call -> Goal scored! 1-0
const s3 = e.processLive({ id: 9003, homeTeam: 'A', awayTeam: 'B', minute: '12', scoreHome: 1, scoreAway: 0 });
console.log(`   Adjustment Note: ${s3.adjustment_note}`);
assert(s3.adjustment_note.includes('[IMMEDIATE RECALC]'), `Adjustment note includes [IMMEDIATE RECALC] indicating bypass`);

// ─── SCENARIO 4: Confidence Deadlock Fix (Min 25%) ────────────────────────────
console.log('\n📋 SCENARIO 4: Confidence Deadlock Fix (Min 25%)');
const s4 = e.processLive({
    id: 9004,
    homeTeam: 'Team X', awayTeam: 'Team Y',
    minute: '15',  // > 10 min
    scoreHome: 1, scoreAway: 0,
    // Very flat stats leading to low natural confidence
    home_win_probability: 34, draw_probability: 33, away_win_probability: 33
});
console.log(`   Confidence: ${s4.confidence}%`);
assert(s4.confidence >= 25, `Confidence floor is firmly >= 25% (got ${s4.confidence}%)`);


// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(58)}`);
console.log(`  Live FPIS v4 Tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('  ✅ ALL V4 SCENARIOS PASSED — Data Integrity updates complete.\n');
    process.exit(0);
} else {
    console.log(`  ❌ ${failed} SCENARIO(S) FAILED.\n`);
    process.exit(1);
}
