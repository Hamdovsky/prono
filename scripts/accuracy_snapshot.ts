/**
 * ⛔ DÉPRÉCIÉ (audit P5, 2026-08-24) — voir CHANGELOG_AUDIT.md ÉTAPE 1.
 * Jumeau TS de accuracy_snapshot.js : métrique dégénérée « tout-X » + look-ahead.
 * Source fiable unique : node scripts/accuracy_report.js -> data/accuracy_report.json
 */
console.warn('[DEPRECATED] accuracy_snapshot.ts est obsolète (métrique biaisée look-ahead). Utilisez: node scripts/accuracy_report.js')
process.exit(0)
