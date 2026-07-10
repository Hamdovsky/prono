const fallbackEnricher = require('../core/fallback_enricher');

(async () => {
  console.log('[FORCE_XGB] Starting XGBoost-first enrichment...');
  const result = await fallbackEnricher.enrichMatchesBatch();
  console.log('[FORCE_XGB] Result:', JSON.stringify(result, null, 2));
  if (result.total === 0) {
    console.log('[FORCE_XGB] No matches to enrich.');
    return;
  }
  console.log(`[FORCE_XGB] Done: ${result.enriched}/${result.total} enriched (XGBoost:${result.xgbOk} JS:${result.jsOk} Failed:${result.failed})`);
})().catch(e => {
  console.error('[FORCE_XGB] Fatal:', e.message);
  process.exit(1);
});
