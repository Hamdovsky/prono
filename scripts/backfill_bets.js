/**
 * scripts/backfill_bets.js — One-shot backfill of settled matches into the
 * 📈 Suivi des Paris (bets) table.
 *
 * Usage:
 *   node scripts/backfill_bets.js            # insert missing bets
 *   node scripts/backfill_bets.js --dry-run  # preview only (no writes)
 *   node scripts/backfill_bets.js --limit 500
 */

const settlementService = require('../services/settlementService')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('-n')
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 1000

;(async () => {
  try {
    const summary = await settlementService.backfillBets({ dryRun, limit })
    console.log(
      `\n[BACKFILL] ${dryRun ? 'DRY-RUN — rien n\'a été écrit.' : 'Terminé.'}` +
        `\n  matchs scannés        : ${summary.scanned}` +
        `\n  insérés               : ${summary.inserted}` +
        `\n  à insérer (dry-run)   : ${summary.wouldInsert}` +
        `\n  déjà présents         : ${summary.alreadyPresent}` +
        `\n  ignorés (sans pick)   : ${summary.skipped}` +
        `\n  erreurs               : ${summary.errors}`
    )
    process.exit(summary.errors > 0 ? 1 : 0)
  } catch (e) {
    console.error('[BACKFILL] FATAL:', e.message)
    process.exit(2)
  }
})()
