/**
 * test_fpis_live_v2.js — Live FPIS Enhancement Tests
 * ────────────────────────────────────────────────────
 * 4 scenarios testing: early heuristics, Bayesian redistribution,
 * multi-angle output, value/trap detection, confidence ≥ 15%.
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

// ─── SCENARIO 1: Early Deficit (min=5, score 0-1) ────────────────────────────
console.log('\n📋 SCENARIO 1: Early Deficit Recovery (min=5, Kerry 0-1 down)');
const s1 = e.processLive({
    homeTeam: 'Kerry FC', awayTeam: 'Sligo Rovers',
    minute: '5',
    scoreHome: 0, scoreAway: 1,
    shots_on_target_home: 1, shots_on_target_away: 2,
    dangerous_attacks_home: 3, dangerous_attacks_away: 5,
    corners_home: 0, corners_away: 1,
    home_win_probability: 0, draw_probability: 0, away_win_probability: 0,  // flat
    odds_home: 2.1, odds_home_open: 2.0,
    odds_away: 3.4, odds_away_open: 3.5,
    home_motivation: 0.75
});
console.log(`   Adjusted: ${s1.adjusted_prediction}`);
console.log(`   Match Type: ${s1.match_type}`);
console.log(`   Confidence: ${s1.confidence}%`);
console.log(`   Alt Angle[0]: ${JSON.stringify(s1.alternative_angle?.[0])}`);
assert(s1.is_live === true, 'is_live flag set');
assert(s1.adjusted_prediction.includes('[LIVE_ADJUSTED]'), 'LIVE_ADJUSTED tag present');
assert(typeof s1.confidence === 'number' && s1.confidence >= 15, `Confidence ≥ 15% (got ${s1.confidence}%)`);
assert(s1.match_type === 'Early-Phase Match', 'Early-Phase Match type triggered');
const hasAH = s1.adjusted_prediction.includes('Asian Handicap') || s1.adjusted_prediction.includes('Next Goal');
assert(hasAH, 'Asian Handicap or Next Goal pivot applied for early deficit');
assert(Array.isArray(s1.alternative_angle) && s1.alternative_angle.length === 3, '3-tier alternative angles returned');
assert(s1.alternative_angle.some(a => a.tier === 'Aggressive'), 'Aggressive tier present');
assert(s1.alternative_angle.some(a => a.tier === 'Moderate'), 'Moderate tier present');
assert(s1.alternative_angle.some(a => a.tier === 'Conservative'), 'Conservative tier present');

// ─── SCENARIO 2: Bayesian Redistribution (flat 33/33/33) ─────────────────────
console.log('\n📋 SCENARIO 2: Anti-Flat-Line — Away odds dropping fast');
const s2 = e.processLive({
    homeTeam: 'Bury', awayTeam: 'Salford City',
    minute: '35',
    scoreHome: 0, scoreAway: 0,
    shots_on_target_home: 2, shots_on_target_away: 3,
    dangerous_attacks_home: 6, dangerous_attacks_away: 9,
    corners_home: 2, corners_away: 4,
    home_win_probability: 33.3, draw_probability: 33.3, away_win_probability: 33.4, // flat
    odds_away: 2.0, odds_away_open: 2.5,  // away odds shortened by 0.5 — strong drift
    odds_home: 3.5, odds_home_open: 3.4
});
console.log(`   Bayesian Away P: ${s2.model_prediction.away} (should be >33%)`);
console.log(`   Adjusted: ${s2.adjusted_prediction}`);
assert(s2.is_live, 'is_live set');
assert(s2.confidence >= 15, `Confidence ≥ 15% (got ${s2.confidence}%)`);
const awayP = parseFloat(s2.model_prediction.away);
assert(awayP > 33, `Bayesian pushed away prob above flat 33% (got ${awayP}%)`);

// ─── SCENARIO 3: Value Opportunity Detection ──────────────────────────────────
console.log('\n📋 SCENARIO 3: Value Opportunity — Home under-priced');
const s3 = e.processLive({
    homeTeam: 'Derry City', awayTeam: 'Dundalk',
    minute: '55',
    scoreHome: 0, scoreAway: 1,
    shots_on_target_home: 5, shots_on_target_away: 2,
    dangerous_attacks_home: 14, dangerous_attacks_away: 4,
    corners_home: 6, corners_away: 1,
    home_win_probability: 45,  draw_probability: 25, away_win_probability: 30,
    odds_home: 2.8, odds_home_open: 2.6,  // odds drifting out for home (under-priced by model)
    _raw_odds_home: 2.8
});
console.log(`   Value Signal: ${s3.value_signal?.signal}`);
console.log(`   Multi-angle:  ${s3.alternative_angle?.map(a=>a.tier).join(' / ')}`);
assert(s3.is_live, 'is_live set');
assert(s3.confidence >= 15, `Confidence ≥ 15% (got ${s3.confidence}%)`);
assert(Array.isArray(s3.alternative_angle) && s3.alternative_angle.length === 3, '3-tier angles present in normal live mode');
assert(s3.value_signal && typeof s3.value_signal.signal === 'string', 'value_signal object present');

// ─── SCENARIO 4: Zero data / null fallback ────────────────────────────────────
console.log('\n📋 SCENARIO 4: Null/Empty live data — guaranteed safe JSON');
const s4 = e.processLive(null);
console.log(`   Adjusted: ${s4.adjusted_prediction}`);
console.log(`   Confidence: ${s4.confidence}%`);
assert(typeof s4 === 'object' && s4 !== null, 'Returns object (not null) on null input');
assert(typeof s4.adjusted_prediction === 'string', 'adjusted_prediction is always a string');
assert(typeof s4.confidence === 'number' && s4.confidence >= 15, `Confidence ≥ 15% even on null (got ${s4.confidence}%)`);
assert(s4.trap_alert && typeof s4.trap_alert.flagged === 'boolean', 'trap_alert.flagged always a boolean');

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(58)}`);
console.log(`  Live FPIS v2 Tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('  ✅ ALL LIVE SCENARIOS PASSED — Dynamic Multi-Angle forecasting active.\n');
    process.exit(0);
} else {
    console.log(`  ❌ ${failed} SCENARIO(S) FAILED.\n`);
    process.exit(1);
}
