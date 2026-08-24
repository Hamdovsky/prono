/**
 * ⛔ DÉPRÉCIÉ (audit P5, 2026-08-24) — voir CHANGELOG_AUDIT.md ÉTAPE 1.
 * Ce script générait promosport_accuracy_trend.json : métrique dégénérée
 * « tout-X » du backfill ML (promosport_xgb.json prédit 96% de nuls) + look-ahead
 * (_getTeamStats sans filtre beforeDate). NE PAS RÉACTIVER.
 * Source fiable unique : node scripts/accuracy_report.js -> data/accuracy_report.json
 */
console.warn('[DEPRECATED] accuracy_snapshot.js est obsolète (métrique biaisée look-ahead). Utilisez: node scripts/accuracy_report.js')
process.exit(0)
