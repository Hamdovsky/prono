/**
 * scripts/accuracy_report.js — Rapport de performance UNIFIÉ (ÉTAPE 1 audit)
 *
 * Appelle accuracyEngine.computeAccuracy() avecle MÊME code pour :
 *  - rolling 7 jours  (dérive opérationnelle / alerte)
 *  - rolling 30 jours
 *  - cumulé           (tendance de fond depuis le début de la rétention)
 * puis écrit data/accuracy_report.json.
 *
 * Remplace les deux métriques divergentes (promosport_accuracy_trend.json et
 * retro_accuracy_report.json) — désormais dépréciées.
 */

const fs = require('fs')
const path = require('path')
const { computeAccuracy } = require('../services/accuracyEngine')

const REPORT_PATH = path.join(__dirname, '..', 'data', 'accuracy_report.json')

function run() {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const from7d = now - 7 * day
  const from30d = now - 30 * day

  const report = {
    generatedAt: new Date(now).toISOString(),
    methodology: {
      description:
        'Métrique unifiée : accuracy brute sur prédictions réellement émises, comparées aux résultats finaux, calculée sur matches (FT) + historical_matches. Snapshot au temps T (prédiction/confiance telles qu\'enregistrées). Whitelist stricte: 1, X, 2, 1X, X2, 12, O/U+seuil. Labels hors whitelist exclus et comptés (excludedLabels).',
      note: 'Remplace les fichiers trompeurs promosport_accuracy_trend.json (backfill ML dégénéré « tout-X ») et retro_accuracy_report.json (oracle du favori avec look-ahead) — voir CHANGELOG_AUDIT.md.',
    },
    rolling: {
      last7days: computeAccuracy({ from: from7d, to: now }),
      last30days: computeAccuracy({ from: from30d, to: now }),
    },
    cumulative: computeAccuracy({ from: null, to: now }),
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
  return report
}

if (require.main === module) {
  const r = run()
  console.log(`✅ Rapport écrit: ${REPORT_PATH}`)
  const fmt = (x) => (x && x.summary ? `${x.summary.total} matchs, ${x.summary.correct} corrects, acc=${x.summary.accuracyPct} (empty=${x.empty})` : 'N/A')
  console.log('  rolling 7j : ' + fmt(r.rolling.last7days))
  console.log('  rolling 30j: ' + fmt(r.rolling.last30days))
  console.log('  cumulé     : ' + fmt(r.cumulative))
}

module.exports = { run }
