const fs = require('fs')
const path = require('path')
const promosportSurpriseService = require('../services/promosportSurpriseService')

function bestSingle(p1, px, p2) {
  const max = Math.max(p1, px, p2)
  return { pick: p1 === max ? '1' : p2 === max ? '2' : 'X', prob: max }
}

function bestDouble(p1, px, p2) {
  const pairs = [
    { pick: ['1', 'X'], prob: p1 + px },
    { pick: ['1', '2'], prob: p1 + p2 },
    { pick: ['X', '2'], prob: px + p2 },
  ]
  return pairs.reduce((a, b) => (b.prob > a.prob ? b : a))
}

function predictEV(p1, px, p2) {
  return bestSingle(p1, px, p2)
}

function predictHighValue(p1, px, p2) {
  const max = Math.max(p1, px, p2)
  const pick = max > 0.6 ? (p1 === max ? '1' : p2 === max ? '2' : 'X') : 'X'
  return { pick, prob: pick === '1' ? p1 : pick === '2' ? p2 : px }
}

function isCorrect(pick, actual) {
  if (Array.isArray(pick)) return pick.includes(actual)
  return pick === actual
}

function computeProbs(homeStats, awayStats) {
  const h = homeStats || {}
  const a = awayStats || {}
  const rh = h.homeWinRate != null ? h.homeWinRate / 100 : 0.424
  const rhd = h.homeDrawRate != null ? h.homeDrawRate / 100 : 0.259
  const rhl = h.homeLossRate != null ? h.homeLossRate / 100 : 0.317
  const rw = a.awayWinRate != null ? a.awayWinRate / 100 : 0.317
  const rwd = a.awayDrawRate != null ? a.awayDrawRate / 100 : 0.259
  const rwl = a.awayLossRate != null ? a.awayLossRate / 100 : 0.424

  let p1 = rh * 0.6 + rwl * 0.4
  let px = rhd * 0.5 + rwd * 0.5
  let p2 = rhl * 0.6 + rw * 0.4

  const total = p1 + px + p2
  p1 /= total
  px /= total
  p2 /= total
  return { p1, px, p2 }
}

function selectDoubles(matches, count = 5) {
  const scored = matches.map((m, i) => {
    const s = bestSingle(m.p1, m.px, m.p2)
    const d = bestDouble(m.p1, m.px, m.p2)
    return { idx: i, gain: d.prob - s.prob }
  })
  scored.sort((a, b) => b.gain - a.gain)
  const selected = new Set(scored.slice(0, count).map((s) => s.idx))
  return selected
}

async function main() {
  console.log("📊 RÉTRO-ANALYSE D'ACCURACY TITANIUM")
  console.log('======================================\n')

  promosportSurpriseService.computeSurpriseRates()

  const dataPath = path.join(__dirname, '..', 'data', 'promosport_historical_results.json')
  const historical = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
  console.log(`📂 Chargé ${historical.length} concours historiques\n`)

  let totalMatches = 0
  const results = []
  const perConcours = []

  for (const concours of historical) {
    const concoursResult = { no: concours.no, id: concours.id, matches: [] }
    let cEV = 0,
      cHV = 0
    const cEVd = 0,
      cHVd = 0
    let cTot = 0

    for (const m of concours.matches) {
      const actual = m.res
      if (!['1', 'X', '2'].includes(actual)) continue

      const homeStats = promosportSurpriseService.getSurpriseStats(m.home)
      const awayStats = promosportSurpriseService.getSurpriseStats(m.away)
      const { p1, px, p2 } = computeProbs(homeStats.team, awayStats.team)

      totalMatches++
      cTot++

      const matchInfo = {
        idx: m.idx,
        home: m.home,
        away: m.away,
        actual,
        p1: +(p1 * 100).toFixed(1),
        px: +(px * 100).toFixed(1),
        p2: +(p2 * 100).toFixed(1),
      }

      const ev = predictEV(p1, px, p2)
      const hv = predictHighValue(p1, px, p2)

      const evCorrect = isCorrect(ev.pick, actual)
      const hvCorrect = isCorrect(hv.pick, actual)

      if (evCorrect) cEV++
      if (hvCorrect) cHV++

      matchInfo.evPick = ev.pick
      matchInfo.evProb = +(ev.prob * 100).toFixed(1)
      matchInfo.evCorrect = evCorrect
      matchInfo.hvPick = hv.pick
      matchInfo.hvProb = +(hv.prob * 100).toFixed(1)
      matchInfo.hvCorrect = hvCorrect

      concoursResult.matches.push(matchInfo)
    }

    concoursResult.total = cTot
    concoursResult.evCorrect = cEV
    concoursResult.hvCorrect = cHV
    results.push(concoursResult)
    perConcours.push({ no: concours.no, total: cTot, ev: cEV, hv: cHV })
  }

  console.log(`📊 Analyse de ${totalMatches} matchs sur ${results.length} concours\n`)

  let totalEV = 0,
    totalHV = 0
  let totalEVd = 0,
    totalHVd = 0
  const allMatches = []
  const allP1s = []
  const probsVsCorrect = { ev: [], hv: [] }
  let totalDoubledMatchesEV = 0,
    correctDoubledEV = 0
  let totalDoubledMatchesHV = 0,
    correctDoubledHV = 0
  const calibrationBins = {
    ev: {
      '50-60': { n: 0, c: 0 },
      '60-70': { n: 0, c: 0 },
      '70-80': { n: 0, c: 0 },
      '80-90': { n: 0, c: 0 },
      '90+': { n: 0, c: 0 },
    },
    hv: {
      '50-60': { n: 0, c: 0 },
      '60-70': { n: 0, c: 0 },
      '70-80': { n: 0, c: 0 },
      '80-90': { n: 0, c: 0 },
      '90+': { n: 0, c: 0 },
    },
  }

  for (const cr of results) {
    const probs = cr.matches.map((m) => ({ p1: m.p1 / 100, px: m.px / 100, p2: m.p2 / 100 }))
    const doubleIdxs = selectDoubles(
      probs.map((p, i) => ({ ...p, idx: i, id: i })),
      5
    )
    const doubleIds = new Set(Array.from(doubleIdxs))

    let cEVd = 0,
      cHVd = 0
    let doubledEV = 0,
      correctD_EV = 0
    let doubledHV = 0,
      correctD_HV = 0

    for (let i = 0; i < cr.matches.length; i++) {
      const m = cr.matches[i]
      const p = probs[i]
      const isD = doubleIds.has(i)

      const evPick = isD ? bestDouble(p.p1, p.px, p.p2) : bestSingle(p.p1, p.px, p.p2)
      const hv = predictHighValue(p.p1, p.px, p.p2)
      const hvPick = isD ? bestDouble(p.p1, p.px, p.p2) : hv

      const evCorrectD = isCorrect(evPick.pick, m.actual)
      const hvCorrectD = isCorrect(hvPick.pick, m.actual)

      if (evCorrectD) cEVd++
      if (hvCorrectD) cHVd++

      if (isD) {
        doubledEV++
        correctD_EV += evCorrectD ? 1 : 0
        doubledHV++
        correctD_HV += hvCorrectD ? 1 : 0
      }

      const binEV =
        m.evProb >= 90
          ? '90+'
          : m.evProb >= 80
            ? '80-90'
            : m.evProb >= 70
              ? '70-80'
              : m.evProb >= 60
                ? '60-70'
                : '50-60'
      if (calibrationBins.ev[binEV]) {
        calibrationBins.ev[binEV].n++
        if (m.evCorrect) calibrationBins.ev[binEV].c++
      }
      const probHV = +((hvProb) =>
        hvProb >= 90
          ? '90+'
          : hvProb >= 80
            ? '80-90'
            : hvProb >= 70
              ? '70-80'
              : hvProb >= 60
                ? '60-70'
                : '50-60')(m.hvProb)
      if (calibrationBins.hv[probHV]) {
        calibrationBins.hv[probHV].n++
        if (m.hvCorrect) calibrationBins.hv[probHV].c++
      }

      allMatches.push(m)
      if (m.p1 != null) allP1s.push(m.p1)
    }

    totalEV += cr.evCorrect
    totalHV += cr.hvCorrect
    totalEVd += cEVd
    totalHVd += cHVd
    totalDoubledMatchesEV += doubledEV
    correctDoubledEV += correctD_EV
    totalDoubledMatchesHV += doubledHV
    correctDoubledHV += correctD_HV
  }

  const N = totalMatches
  const evPct = ((totalEV / N) * 100).toFixed(1)
  const hvPct = ((totalHV / N) * 100).toFixed(1)
  const evdPct = ((totalEVd / N) * 100).toFixed(1)
  const hvdPct = ((totalHVd / N) * 100).toFixed(1)

  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║         RÉSULTATS — RÉTRO-ANALYSE SUR 370 CONCOURS      ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  console.log(`📈 ACCURACY PAR STRATÉGIE (${N} matchs)`)
  console.log(`─────────────────────────────────────`)
  console.log(`│ Stratégie       │ Simple     │ Avec 5 Doubles │`)
  console.log(`│─────────────────┴────────────┴────────────────│`)
  console.log(`│ EV OPTIMIZED    │ ${evPct}% (${totalEV}/${N}) │ ${evdPct}% (${totalEVd}/${N}) │`)
  const evGain = totalEVd - totalEV
  console.log(`│                 │ gain: +0  │ gain: +${evGain} pts │`)
  console.log(`│───────────────────────────────────────────────│`)
  console.log(`│ HIGH VALUE      │ ${hvPct}% (${totalHV}/${N}) │ ${hvdPct}% (${totalHVd}/${N}) │`)
  const hvGain = totalHVd - totalHV
  console.log(`│                 │ gain: +0  │ gain: +${hvGain} pts │`)
  console.log(`└───────────────────────────────────────────────┘\n`)

  console.log(`🔥 IMPACT RÉEL DES DOUBLES`)
  console.log(`──────────────────────────`)
  const evRealGain = (totalEVd / N - totalEV / N) * 100
  const hvRealGain = (totalHVd / N - totalHV / N) * 100
  console.log(`│ EV OPTIMIZED : +${evRealGain.toFixed(1)} points de pourcentage`)
  console.log(`│ HIGH VALUE   : +${hvRealGain.toFixed(1)} points de pourcentage`)
  console.log(
    `│ ${totalDoubledMatchesEV} matchs doublés EV, ${correctDoubledEV}/${totalDoubledMatchesEV} corrects (${((correctDoubledEV / totalDoubledMatchesEV) * 100).toFixed(1)}%)`
  )
  console.log(
    `│ ${totalDoubledMatchesHV} matchs doublés HV, ${correctDoubledHV}/${totalDoubledMatchesHV} corrects (${((correctDoubledHV / totalDoubledMatchesHV) * 100).toFixed(1)}%)`
  )
  console.log('')

  console.log(`📊 CALIBRATION (EV OPTIMIZED)`)
  console.log(`─────────────────────────────`)
  for (const [bin, data] of Object.entries(calibrationBins.ev)) {
    if (data.n > 0) {
      const actualPct = ((data.c / data.n) * 100).toFixed(1)
      const binMid = bin === '90+' ? '90-100' : bin
      const expected =
        bin === '90+' ? 95 : bin === '80-90' ? 85 : bin === '70-80' ? 75 : bin === '60-70' ? 65 : 55
      const diff = (parseFloat(actualPct) - expected).toFixed(1)
      const sign = diff >= 0 ? '+' : ''
      console.log(
        `│ ${binMid}%  → prédit ${expected}%, réel ${actualPct}% (${sign}${diff}pts) [${data.c}/${data.n}]`
      )
    }
  }
  console.log('')

  console.log(`🏆 TOP 10 CONCOURS LES PLUS RÉUSSIS (EV)`)
  console.log(`────────────────────────────────────────`)
  perConcours
    .sort((a, b) => b.ev - a.ev)
    .slice(0, 10)
    .forEach((x) => {
      console.log(
        `│ N°${x.no.padStart(3)} : ${x.ev}/${x.total} corrects (${((x.ev / x.total) * 100).toFixed(0)}%)`
      )
    })
  console.log('')

  console.log(`💀 TOP 10 CONCOURS LES PLUS DIFFICILES (EV)`)
  console.log(`───────────────────────────────────────────`)
  perConcours
    .sort((a, b) => a.ev - b.ev)
    .slice(0, 10)
    .forEach((x) => {
      console.log(
        `│ N°${x.no.padStart(3)} : ${x.ev}/${x.total} corrects (${((x.ev / x.total) * 100).toFixed(0)}%)`
      )
    })
  console.log('')

  const report = {
    generatedAt: new Date().toISOString(),
    totalConcours: results.length,
    totalMatches: N,
    strategies: {
      EV_OPTIMIZED: {
        simple: { correct: totalEV, total: N, accuracy: parseFloat(evPct) },
        with5Doubles: { correct: totalEVd, total: N, accuracy: parseFloat(evdPct) },
        gain: evGain,
        gainPct: +evRealGain.toFixed(1),
      },
      HIGH_VALUE: {
        simple: { correct: totalHV, total: N, accuracy: parseFloat(hvPct) },
        with5Doubles: { correct: totalHVd, total: N, accuracy: parseFloat(hvdPct) },
        gain: hvGain,
        gainPct: +hvRealGain.toFixed(1),
      },
    },
    doublePerformance: {
      EV: {
        doubled: totalDoubledMatchesEV,
        correct: correctDoubledEV,
        accuracy: +((correctDoubledEV / totalDoubledMatchesEV) * 100).toFixed(1),
      },
      HV: {
        doubled: totalDoubledMatchesHV,
        correct: correctDoubledHV,
        accuracy: +((correctDoubledHV / totalDoubledMatchesHV) * 100).toFixed(1),
      },
    },
    calibration: {
      EV_OPTIMIZED: Object.fromEntries(
        Object.entries(calibrationBins.ev).map(([k, v]) => [
          k,
          v.n > 0
            ? { predicted: k, actual: +((v.c / v.n) * 100).toFixed(1), count: v.n, correct: v.c }
            : { predicted: k, actual: 0, count: 0, correct: 0 },
        ])
      ),
      HIGH_VALUE: Object.fromEntries(
        Object.entries(calibrationBins.hv).map(([k, v]) => [
          k,
          v.n > 0
            ? { predicted: k, actual: +((v.c / v.n) * 100).toFixed(1), count: v.n, correct: v.c }
            : { predicted: k, actual: 0, count: 0, correct: 0 },
        ])
      ),
    },
    perConcours: perConcours.map((x) => ({
      no: x.no,
      evCorrect: x.ev,
      hvCorrect: x.hv,
      total: x.total,
      evPct: +((x.ev / x.total) * 100).toFixed(1),
      hvPct: +((x.hv / x.total) * 100).toFixed(1),
    })),
  }

  const reportPath = path.join(__dirname, '..', 'data', 'retro_accuracy_report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`💾 Rapport sauvegardé: ${reportPath}`)
  console.log('\n✅ Analyse terminée.')
}

main().catch(console.error)
