// @ts-nocheck
import fs from 'fs'
import path from 'path'
import logger from '../core/logger'

const BENCHMARK_PATH = path.join(__dirname, '..', 'data', 'promosport_benchmark.json')

function runBenchmark() {
  try {
    import promosportResultService from '../services/promosportResultService'
    import Database from 'better-sqlite3'
    const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')

    const db = new Database(ARCHIVE_PATH, { readonly: true })
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='promosport_predictions'`
      )
      .get()
    if (!tables) {
      db.close()
      logger.warn('[BENCHMARK] No predictions table yet')
      return null
    }

    // Load all predictions joined with results
    const rows = db
      .prepare(
        `
      SELECT pp.choices, pa.result, pa.vote_home, pa.vote_draw, pa.vote_away
      FROM promosport_predictions pp
      INNER JOIN promosport_archive pa
        ON pp.concours = pa.concours AND pp.match_idx = pa.match_idx
      WHERE pa.result IS NOT NULL AND pa.result != 'N'
    `
      )
      .all()
    db.close()

    if (rows.length === 0) return null

    let modelCorrect = 0,
      modelTotal = 0
    let crowdCorrect = 0,
      crowdTotal = 0
    let randomCorrect = 0,
      randomTotal = 0
    const total = rows.length

    for (const r of rows) {
      const choices = JSON.parse(r.choices || '[]')
      const result = r.result

      // Model prediction (first choice)
      if (choices.length === 1) {
        modelTotal++
        if (choices[0] === result) modelCorrect++
      } else {
        modelTotal++
        if (choices.includes(result)) modelCorrect++
      }

      // Crowd prediction (most voted)
      const votes = [
        { label: '1', pct: r.vote_home || 33 },
        { label: 'X', pct: r.vote_draw || 33 },
        { label: '2', pct: r.vote_away || 33 },
      ]
      votes.sort((a, b) => b.pct - a.pct)
      const crowdPick = votes[0].label
      if (crowdPick === result) crowdCorrect++
      crowdTotal++

      // Random (33% chance)
      const randomPick = ['1', 'X', '2'][Math.floor(Math.random() * 3)]
      if (randomPick === result) randomCorrect++
      randomTotal++
    }

    const modelAcc = ((modelCorrect / modelTotal) * 100).toFixed(1)
    const crowdAcc = ((crowdCorrect / crowdTotal) * 100).toFixed(1)
    const randomAcc = ((randomCorrect / randomTotal) * 100).toFixed(1)
    const edge = (parseFloat(modelAcc) - parseFloat(crowdAcc)).toFixed(1)

    const entry = {
      date: new Date().toISOString().slice(0, 10),
      timestamp: Date.now(),
      totalMatches: total,
      model: { correct: modelCorrect, total: modelTotal, accuracy: modelAcc + '%' },
      crowd: { correct: crowdCorrect, total: crowdTotal, accuracy: crowdAcc + '%' },
      random: { correct: randomCorrect, total: randomTotal, accuracy: randomAcc + '%' },
      edgeOverCrowd: edge + '%',
    }

    // Save benchmark
    const benchmarks = loadBenchmarks()
    benchmarks.push(entry)
    while (benchmarks.length > 52) benchmarks.shift() // keep 1 year
    fs.writeFileSync(BENCHMARK_PATH, JSON.stringify(benchmarks, null, 2), 'utf8')

    logger.info(
      `[BENCHMARK] Model: ${modelAcc}% | Crowd: ${crowdAcc}% | Random: ${randomAcc}% | Edge: ${edge}%`
    )

    // Alert if model is worse than crowd
    if (parseFloat(edge) < -3) {
      try {
        import botService from '../services/botService'
        botService.sendAlert(
          `⚠️ <b>Benchmark Promosport</b>\nModèle (${modelAcc}%) ${edge > 0 ? 'pire' : 'moins bon'} que crowd (${crowdAcc}%)\nEdge: ${edge}%\n⚠️ Le modèle régresse face à la foule!`
        )
      } catch (_) {}
    }

    // Alert if model is worse than random
    if (parseFloat(modelAcc) < parseFloat(randomAcc) + 2) {
      try {
        import botService from '../services/botService'
        botService.sendAlert(
          `🚨 <b>Benchmark Critique!</b>\nModèle (${modelAcc}%) pas mieux qu'aléatoire (${randomAcc}%)!\n⚠️ Retrain manuel nécessaire.`
        )
      } catch (_) {}
    }

    return entry
  } catch (e) {
    logger.error(`[BENCHMARK] Error: ${e.message}`)
    return null
  }
}

function loadBenchmarks() {
  try {
    if (fs.existsSync(BENCHMARK_PATH)) {
      return JSON.parse(fs.readFileSync(BENCHMARK_PATH, 'utf8'))
    }
  } catch (_) {}
  return []
}

if (require.main === module) {
  runBenchmark()
}

export = { runBenchmark, loadBenchmarks }
