/**
 * diagnose_1x2.js — Audit P4 : diagnostic du marché 1X2 pur.
 *
 * Questions traitées (cf. plan validé) :
 *   1. L'erreur est-elle concentrée sur un type de match (favori / outsider /
 *      match serré) ou uniforme ?
 *   2. Y a-t-il un biais directionnel (sur-prédiction des victoires à
 *      domicile, des nuls, de l'extérieur) ?
 *   3. Le nul plombe-t-il la moyenne ? (accuracy en excluant les picks X)
 *   4. Confiance moyenne par issue prédite vs taux réel.
 *
 * Sources : mêmes périmètres qu'accuracyEngine (matches FT + historical_matches,
 * snapshot au temps T). Sortie : console + data/diagnosis_1x2.json.
 *
 * Critère de réactivation du 1X2 pur : accuracy calibrée ≥ 42,6 % (break-even
 * à cote moyenne 2,35) sur un échantillon n ≥ 200.
 */
const fs = require('fs')
const path = require('path')

const OUT_PATH = path.join(__dirname, '..', 'data', 'diagnosis_1x2.json')
const MIN_SAMPLE = 15

function pct(n, d) {
  return d > 0 ? +((n / d) * 100).toFixed(1) : null
}

function actualOutcome(h, a) {
  if (h == null || a == null) return null
  return h > a ? '1' : h < a ? '2' : 'X'
}

function collectRecords(db) {
  const FT = ['FT', 'finished', 'Finished', 'Ended']
  const records = []

  try {
    const rows = db
      .prepare(`SELECT * FROM matches WHERE status IN (${FT.map(() => '?').join(',')})`)
      .all(...FT)
    for (const r of rows) {
      const pick = r.prediction != null ? String(r.prediction).toUpperCase().trim() : null
      if (!['1', 'X', '2'].includes(pick)) continue
      const actual = actualOutcome(r.scoreHome, r.scoreAway)
      if (!actual) continue
      records.push({
        pick,
        actual,
        oddsHome: r.odds_home != null ? Number(r.odds_home) : null,
        confidence: r.confidence != null ? Number(r.confidence) : null,
      })
    }
  } catch (_) {}

  try {
    const rows = db.prepare('SELECT * FROM historical_matches').all()
    for (const r of rows) {
      let fd = {}
      try {
        fd = JSON.parse(r.fullData || '{}')
      } catch {}
      const pick = fd.prediction != null ? String(fd.prediction).toUpperCase().trim() : null
      if (!['1', 'X', '2'].includes(pick)) continue
      const actual = actualOutcome(r.scoreHome, r.scoreAway)
      if (!actual) continue
      records.push({
        pick,
        actual,
        oddsHome: fd.odds_home ?? fd.home_odds ?? null,
        confidence: fd.confidence ?? null,
      })
    }
  } catch (_) {}

  return records
}

function main() {
  const db = require('../core/database').db
  const records = collectRecords(db)
  const n = records.length

  if (n === 0) {
    console.log('⚠️ Aucun pick 1X2 pur évaluable — rien à diagnostiquer.')
    process.exit(0)
  }

  // ── 2. Biais directionnel : prédit vs réalisé ──
  const byPredicted = { '1': { t: 0, c: 0 }, X: { t: 0, c: 0 }, '2': { t: 0, c: 0 } }
  const byActual = { '1': 0, X: 0, '2': 0 }
  for (const r of records) {
    byPredicted[r.pick].t++
    if (r.pick === r.actual) byPredicted[r.pick].c++
    byActual[r.actual]++
  }

  // ── 1. Concentration de l'erreur par type de match (via cote domicile) ──
  const buckets = {
    favori_domestic_strong: { desc: 'cote dom ≤ 1.60 (favori net)', t: 0, c: 0 },
    equilibre: { desc: 'cote dom 1.60–2.50 (équilibré)', t: 0, c: 0 },
    outsider_ou_serre: { desc: 'cote dom > 2.50 ou absente (outsider/serré)', t: 0, c: 0 },
  }
  for (const r of records) {
    const o = r.oddsHome
    let key
    if (o == null || o > 2.5) key = 'outsider_ou_serre'
    else if (o <= 1.6) key = 'favori_domestic_strong'
    else key = 'equilibre'
    buckets[key].t++
    if (r.pick === r.actual) buckets[key].c++
  }

  // ── 3. Impact du nul ──
  const noDrawPicks = records.filter((r) => r.pick !== 'X')
  const accGlobal = pct(records.filter((r) => r.pick === r.actual).length, n)
  const accSansPicksNuls = pct(
    noDrawPicks.filter((r) => r.pick === r.actual).length,
    noDrawPicks.length
  )

  // ── 4. Confiance affichée vs réalité ──
  const confByPick = {}
  for (const r of records) {
    if (r.confidence == null || !Number.isFinite(r.confidence)) continue
    confByPick[r.pick] = confByPick[r.pick] || { sum: 0, t: 0, c: 0 }
    confByPick[r.pick].sum += r.confidence
    confByPick[r.pick].t++
    if (r.pick === r.actual) confByPick[r.pick].c++
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sampleSize: n,
    minSampleForReactivation: 200,
    reactivationThresholdPct: 42.6,
    verdict:
      n < 200
        ? `ÉCHANTILLON INSUFFISANT (n=${n} < 200) — décision de réactivation reportée`
        : accGlobal >= 42.6
          ? `SEUIL ATTEINT (${accGlobal}% ≥ 42.6%) — réactivation du 1X2 pur à étudier`
          : `SOUS LE SEUIL (${accGlobal}% < 42.6%) — maintien du masquage DISABLE_PURE_1X2`,
    directionalBias: {
      note: 'accuracy par issue PRÉDITE (sur-prédiction ?) + distribution des issues RÉELLES',
      byPredicted: Object.fromEntries(
        Object.entries(byPredicted).map(([k, v]) => [
          k,
          { predicted: k, total: v.t, correct: v.c, accuracy: pct(v.c, v.t), sampleOk: v.t >= MIN_SAMPLE },
        ])
      ),
      actualDistribution: Object.fromEntries(
        Object.entries(byActual).map(([k, v]) => [k, { count: v, share: pct(v, n) }])
      ),
    },
    errorConcentration: Object.fromEntries(
      Object.entries(buckets).map(([k, v]) => [
        k,
        { desc: v.desc, total: v.t, correct: v.c, accuracy: pct(v.c, v.t), sampleOk: v.t >= MIN_SAMPLE },
      ])
    ),
    drawImpact: {
      picksX: byPredicted.X.t,
      accuracyAllPicks: accGlobal,
      accuracyExcludingXPicks: accSansPicksNuls,
      note: "Si accuracyExcludingXPicks >> accuracyAllPicks → le nul structurel plombe le 1X2 ; envisager l'exclusion des picks X plutôt que du marché entier.",
    },
    confidenceVsReality: Object.fromEntries(
      Object.entries(confByPick).map(([k, v]) => [
        k,
        {
          avgConfidence: +(v.sum / v.t).toFixed(1),
          realAccuracy: pct(v.c, v.t),
          n: v.t,
          overconfident: v.sum / v.t - pct(v.c, v.t) > 5,
        },
      ])
    ),
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2))

  console.log(`\n═══ DIAGNOSTIC 1X2 PUR (n=${n}) ═══`)
  console.log(`Verdict : ${report.verdict}`)
  console.log('\nBiais directionnel (par issue prédite) :')
  for (const [k, v] of Object.entries(report.directionalBias.byPredicted))
    console.log(`  ${k}: ${v.accuracy}% (${v.correct}/${v.total})${v.sampleOk ? '' : ' ⚠️ n<15'}`)
  console.log('Distribution réelle :')
  for (const [k, v] of Object.entries(report.directionalBias.actualDistribution))
    console.log(`  ${k}: ${v.count} matchs (${v.share}%)`)
  console.log('\nConcentration par type de match :')
  for (const [k, v] of Object.entries(report.errorConcentration))
    console.log(`  ${k} [${v.desc}]: ${v.accuracy}% (n=${v.total})${v.sampleOk ? '' : ' ⚠️ n<15'}`)
  console.log('\nImpact du nul :')
  console.log(`  Accuracy globale           : ${accGlobal}%`)
  console.log(`  Accuracy sans picks X      : ${accSansPicksNuls}% (exclut ${byPredicted.X.t} picks X)`)
  console.log('\nConfiance affichée vs réalité :')
  for (const [k, v] of Object.entries(report.confidenceVsReality))
    console.log(
      `  ${k}: confiance ${v.avgConfidence}% vs réel ${v.realAccuracy}%${v.overconfident ? ' 🔴 SUR-CONFIANT' : ''} (n=${v.n})`
    )
  console.log(`\nRapport écrit : ${OUT_PATH}\n`)
}

try {
  main()
} catch (e) {
  console.error('[DIAGNOSE_1X2] Erreur:', e.message)
  process.exit(1)
}
