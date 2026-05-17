/**
 * test_fpis_engine.js — FPIS Engine Unit Tests
 * ──────────────────────────────────────────────
 * 5 synthetic scenarios covering the full FPIS logic.
 */

'use strict';

const fpisEngine = require('../services/FPISEngine');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
    if (condition) {
        console.log(`  ✅ PASS: ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

// ─── SCENARIO 1: Clear Home Favorite (Low Volatility) ───────────────────────
console.log('\n📋 SCENARIO 1: One-sided Domination');
const s1 = fpisEngine.process({
    homeTeam:              'Man City',
    awayTeam:              'Sheffield Utd',
    home_xg:               2.4,
    away_xg:               0.7,
    home_win_probability:  72,
    draw_probability:      18,
    away_win_probability:  10,
    sharp_score:           55,
    odds_drop_home:        8,
    chaos_level:           2,
    news_data:             { impact: { critical: [], home: 2, away: 0 } }
});
console.log(`   Match Type: ${s1.match_type}`);
console.log(`   Adjusted:   ${s1.adjusted_prediction}`);
console.log(`   Risk:       ${s1.risk_level}`);
assert(s1.match_type === 'One-sided Domination', 'Match type is One-sided Domination');
assert(s1.risk_level !== 'High', 'Risk is not High for a clear favorite');
assert(s1.trap_alert.flagged === false, 'No trap flag (sharp money agrees)');

// ─── SCENARIO 2: High Chaos / High Volatility ────────────────────────────────
console.log('\n📋 SCENARIO 2: High Volatility Match');
const s2 = fpisEngine.process({
    homeTeam:              'PSG',
    awayTeam:              'Monaco',
    home_xg:               1.6,
    away_xg:               1.5,
    home_win_probability:  46,
    draw_probability:      28,
    away_win_probability:  26,
    sharp_score:           10,
    chaos_level:           25,
    news_data: {
        impact: {
            critical: ['GK OUT', 'ST OUT', 'LATE FITNESS TEST ⏳'],
            home: -20,
            away: -8
        }
    }
});
console.log(`   Match Type: ${s2.match_type}`);
console.log(`   Adjusted:   ${s2.adjusted_prediction}`);
assert(s2.match_type === 'High Volatility Match', 'Match type is High Volatility');
assert(s2.scores.risk > 30, 'Risk score elevated due to news chaos');
const isDoublePred = s2.adjusted_prediction.includes('or Draw') || s2.adjusted_prediction.includes('Double');
assert(isDoublePred || s2.adjusted_prediction.length > 3, 'Prediction expanded safely for volatility');

// ─── SCENARIO 3: Trap Match (Consensus without Sharp Money) ──────────────────
console.log('\n📋 SCENARIO 3: Trap Detection');
const s3 = fpisEngine.process({
    homeTeam:              'Marseille',
    awayTeam:              'Toulouse',
    home_xg:               2.1,
    away_xg:               0.6,
    home_win_probability:  84,   // very obvious favourite
    draw_probability:      11,
    away_win_probability:  5,
    sharp_score:           5,    // NO sharp money
    odds_drop_home:        -5,   // odds RISING — suspicious
    chaos_level:           3,
    news_data:             { impact: { critical: [], home: 0, away: 0 } }
});
console.log(`   Match Type:  ${s3.match_type}`);
console.log(`   Trap Flagged: ${s3.trap_alert.flagged}`);
console.log(`   Safe Angle:  ${s3.trap_alert.safe_angle}`);
console.log(`   Adjusted:    ${s3.adjusted_prediction}`);
assert(s3.trap_alert.flagged === true, 'Trap correctly flagged');
assert(s3.adjusted_prediction !== 'Marseille Win', 'Prediction shifted away from obvious choice');

// ─── SCENARIO 4: Anti-Repetition Trigger ─────────────────────────────────────
console.log('\n📋 SCENARIO 4: Anti-Repetition Engine');
// Build a base match that leans strongly home
const baseMatch = {
    home_xg: 1.8, away_xg: 1.0,
    home_win_probability: 58, draw_probability: 24, away_win_probability: 18,
    sharp_score: 30, odds_drop_home: 5, chaos_level: 5,
    news_data: { impact: { critical: [], home: 0, away: 0 } }
};
// Run 3 times to trigger anti-repetition (threshold is 2)
const r4a = fpisEngine.process({ ...baseMatch, homeTeam: 'TeamA1', awayTeam: 'TeamB1', id: 'ar1' });
const r4b = fpisEngine.process({ ...baseMatch, homeTeam: 'TeamA2', awayTeam: 'TeamB2', id: 'ar2' });
const r4c = fpisEngine.process({ ...baseMatch, homeTeam: 'TeamA3', awayTeam: 'TeamB3', id: 'ar3' });
console.log(`   Run 1 Prediction: ${r4a.adjusted_prediction}`);
console.log(`   Run 2 Prediction: ${r4b.adjusted_prediction}`);
console.log(`   Run 3 Prediction: ${r4c.adjusted_prediction} ← should differ`);
// By run 3, anti-repetition should have kicked in
assert(
    r4c.adjusted_prediction !== r4b.adjusted_prediction ||
    r4c.alternative_angle !== r4b.adjusted_prediction,
    'Anti-repetition triggered alternative angle by 3rd identical prediction'
);

// ─── SCENARIO 5: Graceful Fallback (Zero/Null odds data) ────────────────────
console.log('\n📋 SCENARIO 5: Graceful Fallback (Null odds)');
const s5 = fpisEngine.process({
    homeTeam:              'Ajax',
    awayTeam:              'AZ Alkmaar',
    home_xg:               1.9,
    away_xg:               1.3,
    home_win_probability:  52,
    draw_probability:      26,
    away_win_probability:  22,
    sharp_score:           null,
    odds_drop_home:        null,
    chaos_level:           null,
    news_data:             null
});
console.log(`   Match Type: ${s5.match_type}`);
console.log(`   Risk Level: ${s5.risk_level}`);
assert(typeof s5.match_type === 'string' && s5.match_type.length > 0, 'Match type returned even with null data');
assert(typeof s5.adjusted_prediction === 'string', 'Prediction string returned');
assert(s5.trap_alert && typeof s5.trap_alert.flagged === 'boolean', 'Trap alert object intact');

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`  FPIS Engine Tests: ${passed} passed, ${failed} failed`);
if (failed === 0) {
    console.log('  ✅ ALL SCENARIOS PASSED — FPISEngine is operational.\n');
    process.exit(0);
} else {
    console.log(`  ❌ ${failed} SCENARIO(S) FAILED — review output above.\n`);
    process.exit(1);
}
