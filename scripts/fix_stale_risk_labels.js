#!/usr/bin/env node
/**
 * fix_stale_risk_labels — nettoyage one-shot des champs périmés (Chantier 2, ÉTAPE 2 audit)
 *
 * Sur le slate actif (`matches` uniquement — JAMAIS `historical_matches`), corrige les
 * incohérences héritées de l'ancien comportement asymétrique du HONESTY GATE :
 *   - risk_label === 'PENDING' alors que sufficient top-level === true (19 lignes)
 *   - enriched.sufficient en contradiction avec le sufficient top-level (35 lignes)
 *
 * Le top-level `sufficient` est la source de vérité de LA passe courante.
 *
 * Usage :
 *   node scripts/fix_stale_risk_labels.js          # dry-run (par défaut, rien n'est écrit)
 *   node scripts/fix_stale_risk_labels.js --apply  # écriture réelle
 */

const database = require('../core/database')

const DRY_RUN = !process.argv.includes('--apply')

function main() {
  const rows = database.db.prepare('SELECT id, fullData FROM matches').all()
  const fixes = []
  let riskLabelPendingFix = 0
  let enrichedSufficientFix = 0
  let bothFix = 0

  for (const r of rows) {
    let fd = {}
    try {
      fd = JSON.parse(r.fullData || '{}')
    } catch {
      continue
    }
    const currentSufficient = fd.sufficient === true
    let changed = false

    // Cas 1 : suffisant mais risk_label périmé → re-synchroniser sur le verdict courant.
    if (currentSufficient && fd.risk_label === 'PENDING') {
      fd.risk_label = fd.verdict || fd.quant?.risk_label || 'SAFE'
      riskLabelPendingFix++
      changed = true
    }

    // Cas 2 : enriched.sufficient contredit le top-level → aligner sur la passe courante.
    if (
      fd.enriched &&
      typeof fd.enriched === 'object' &&
      fd.enriched.sufficient !== undefined &&
      Boolean(fd.enriched.sufficient) !== currentSufficient
    ) {
      fd.enriched.sufficient = currentSufficient
      if (currentSufficient) {
        fd.enriched.risk_label = fd.risk_label
        fd.enriched.insufficient_data = 0
      } else {
        fd.enriched.risk_label = 'PENDING'
        fd.enriched.insufficient_data = 1
      }
      enrichedSufficientFix++
      changed = true
    }

    if (changed) {
      fixes.push({ id: r.id, fullData: JSON.stringify(fd) })
    }
  }

  // Recalcule précis du comptage (les compteurs précédents cumulent, pas par-ligne).
  const byId = new Map()
  for (const r of rows) {
    let fd = {}
    try {
      fd = JSON.parse(r.fullData || '{}')
    } catch {
      continue
    }
    const currentSufficient = fd.sufficient === true
    const c1 = currentSufficient && fd.risk_label === 'PENDING'
    const c2 =
      fd.enriched &&
      typeof fd.enriched === 'object' &&
      fd.enriched.sufficient !== undefined &&
      Boolean(fd.enriched.sufficient) !== currentSufficient
    if (c1 || c2) byId.set(r.id, { c1, c2 })
  }
  riskLabelPendingFix = [...byId.values()].filter((x) => x.c1).length
  enrichedSufficientFix = [...byId.values()].filter((x) => x.c2).length
  bothFix = [...byId.values()].filter((x) => x.c1 && x.c2).length

  console.log(`[fix_stale_risk_labels] dryRun=${DRY_RUN}`)
  console.log(`  total matchs analysés   : ${rows.length}`)
  console.log(`  risk_label PENDING stale: ${riskLabelPendingFix}`)
  console.log(`  enriched.sufficient st  : ${enrichedSufficientFix}`)
  console.log(`  dont les deux            : ${bothFix}`)
  console.log(`  lignes à corriger        : ${fixes.length}`)

  if (DRY_RUN) {
  console.log('\n  échantillon (10 max) :')
  for (const f of fixes.slice(0, 10)) {
    const fd = JSON.parse(f.fullData)
    console.log(
      `    - ${f.id} | ${fd.homeTeam || '?'} vs ${fd.awayTeam || '?'} | ${fd.league || '?'} | risk_label=${fd.risk_label} | enr.sufficient=${fd.enriched?.sufficient}`
    )
  }
    console.log('\n  Dry-run : aucune écriture. Relance avec --apply pour appliquer.')
    return
  }

  const upd = database.db.prepare(
    'UPDATE matches SET fullData = ?, last_updated = ? WHERE id = ?'
  )
  let applied = 0
  for (const f of fixes) {
    upd.run(f.fullData, Date.now(), f.id)
    applied++
  }
  console.log(`  [OK] ${applied} lignes corrigées dans matches.`)
}

main()
