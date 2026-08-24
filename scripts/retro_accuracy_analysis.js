/**
 * ⛔ DÉPRÉCIÉ (audit P5, 2026-08-24) — voir CHANGELOG_AUDIT.md ÉTAPE 1.
 * Ce script générait retro_accuracy_report.json : oracle du favori avec
 * look-ahead massif (computeSurpriseRates agrège les 370 concours y compris
 * futurs). L'ancien probabilityCalibrator lisait ce fichier → sur-confiance
 * 0.99/1.0 corrigée en P1. NE PAS RÉACTIVER.
 * Source fiable unique : node scripts/accuracy_report.js -> data/accuracy_report.json
 */
console.warn('[DEPRECATED] retro_accuracy_analysis.js est obsolète (oracle look-ahead). Utilisez: node scripts/accuracy_report.js')
process.exit(0)
