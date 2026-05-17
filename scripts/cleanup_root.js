/**
 * scripts/cleanup_root.js
 * ─────────────────────────────────────────────────────────────
 * Cleans up the project root from debug, temp, and log files
 * that accumulated during development.
 * Run: node scripts/cleanup_root.js
 * DRY RUN:  node scripts/cleanup_root.js --dry
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isDry = process.argv.includes('--dry');

// ─── Files safe to delete ─────────────────────────────────────────────────────

// All .log files in root
const LOG_PATTERNS = [
    /\.log$/,
    /_debug\.(txt|log)$/,
    /crash_out.*\.txt$/,
    /build_(check|err|verify)\.txt$/,
    /check_output.*\.txt$/,
    /report_utf8\.txt$/,
    /elite_output\.txt$/,
    /tactical_output\.txt$/,
    /tactical_lab_final_report\.txt$/,
    /terminal_pronostic\.txt$/,
    /true_output\.txt$/,
    /quick_results\.txt$/,
    /duplicate_results\.txt$/,
    /elite_results\.json$/,
    /test_news_output\.txt$/,
    /test_out\.(txt|json)$/,
    /test_results\.txt$/,
    /node_(err|out)(.*)?\.txt$/,
    /parsed_trace\.txt$/,
    /schema\.json$/,
    /tmp\.json$/,
    /cols\.json$/,
    /matches\.json$/,
    /maccabi_dump\.json$/,
    /sofa_events\.json$/,       // 4.6MB — not needed in repo
    /sofascore_sample\.html$/,
    /sofascore_match_sample\.html$/,
];

// Debug/temp scripts in root (not in use)
const DEBUG_SCRIPTS = new Set([
    'check_category.js',
    'check_category_deep.js',
    'check_daily_counts.js',
    'check_date_range.js',
    'check_db_stats.js',
    'check_duplicates.js',
    'check_duplicates_detailed.js',
    'check_impact.js',
    'check_impact_simple.js',
    'check_leagues.js',
    'check_live_api.js',
    'check_past_scheduled.js',
    'check_saudi.js',
    'check_today.js',
    'check_tournaments.js',
    'crash_tracker.js',
    'db_dump_maccabi.js',
    'db_inspect.js',
    'debug_fuzzy.js',
    'debug_today_matches.js',
    'diag_impact.js',
    'dump_leagues.js',
    'dump_maccabi.js',
    'dump_meta_sample.js',
    'dump_sofa.js',
    'dump_sofa_api.js',
    'dump_sofa_match.js',
    'dump_sofa_match2.js',
    'dump_sofa_scheduled.js',
    'examine_raw_tournament.js',
    'find_duplicates_v3.js',
    'find_predictions.js',
    'find_specific.js',
    'find_specific_v2.js',
    'find_today_duplicates.js',
    'fix_finished_status.js',
    'fix_stale_matches.js',
    'insert_mock_finished.js',
    'insert_mock_news.js',
    'inspect_timestamps.js',
    'list_matches.js',
    'normalize_db.js',
    'parse_logs.js',
    'quick_test.js',
    'read_results.js',
    'repair_matches.js',
    'revert_status.js',
    'search_sofa_json.js',
    'test2.js',
    'test_algorithm.js',
    'test_api_live.js',
    'test_enrich_match.js',
    'test_full_data.js',
    'test_fuzzy_final.js',
    'test_h2h.js',
    'test_localhost.js',
    'test_news_impact.js',
    'test_predict.js',
    'tmp_check_prob.js',
    'verify_timestamp.js',
]);

// ─── Execution ─────────────────────────────────────────────────────────────────

let totalSize = 0;
let count = 0;
const toDelete = [];

const files = fs.readdirSync(ROOT).filter(f => {
    const full = path.join(ROOT, f);
    return fs.statSync(full).isFile();
});

for (const file of files) {
    const full = path.join(ROOT, file);
    const isLog = LOG_PATTERNS.some(p => p.test(file));
    const isDebug = DEBUG_SCRIPTS.has(file);
    if (isLog || isDebug) {
        const size = fs.statSync(full).size;
        totalSize += size;
        count++;
        toDelete.push({ file, full, size, reason: isLog ? 'log/temp' : 'debug-script' });
    }
}

const fmt = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${(b / 1024).toFixed(1)}KB`;

if (isDry) {
    console.log(`\n🔍 [DRY RUN] Would delete ${count} files (${fmt(totalSize)}):\n`);
    for (const { file, size, reason } of toDelete) {
        console.log(`  🗑️  [${reason}] ${file} (${fmt(size)})`);
    }
    console.log(`\n💡 Run without --dry to actually delete them.\n`);
} else {
    console.log(`\n🗑️  Deleting ${count} files (${fmt(totalSize)})...\n`);
    for (const { file, full, size, reason } of toDelete) {
        try {
            fs.unlinkSync(full);
            console.log(`  ✅ [${reason}] ${file} (${fmt(size)})`);
        } catch (e) {
            console.log(`  ⚠️  Could not delete ${file}: ${e.message}`);
        }
    }
    console.log(`\n✨ Cleanup complete. Freed ~${fmt(totalSize)}.\n`);
}
