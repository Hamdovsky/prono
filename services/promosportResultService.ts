// @ts-nocheck
import Database from 'better-sqlite3'
import path from 'path'
import logger from '../core/logger'
import { scrapeTunisieGrid } from '../core/promosport_tunisie_scraper'

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')

function getDb() {
  return new Database(ARCHIVE_PATH)
}

function storePrediction(concours, date, grids) {
  try {
    const db = getDb()
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS promosport_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concours TEXT NOT NULL,
        date TEXT,
        grid_name TEXT,
        match_idx INTEGER,
        home_team TEXT,
        away_team TEXT,
        choices TEXT,
        created_at DATETIME DEFAULT datetime('now'),
        UNIQUE(concours, grid_name, match_idx)
      )
    `
    ).run()

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO promosport_predictions
        (concours, date, grid_name, match_idx, home_team, away_team, choices, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    const tx = db.transaction(() => {
      for (const grid of grids) {
        for (const match of grid.matches) {
          upsert.run(
            String(concours),
            date,
            grid.name,
            match.id,
            match.home,
            match.away,
            JSON.stringify(match.choices)
          )
        }
      }
    })
    tx()
    db.close()
    logger.info(
      `[PROMOSPORT-RESULT] Stored ${grids.length * 13} predictions for concours ${concours}`
    )
    return true
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] storePrediction error: ${e.message}`)
    return false
  }
}

async function checkAndFetchResults(concoursNumber) {
  try {
    const grid = await scrapeTunisieGrid(concoursNumber)
    if (!grid || !grid.matches || grid.matches.length === 0) {
      logger.info(`[PROMOSPORT-RESULT] No results yet for concours ${concoursNumber}`)
      return null
    }

    const finishedMatches = grid.matches.filter((m) => m.result && m.result !== 'N')
    if (finishedMatches.length === 0) {
      logger.info(`[PROMOSPORT-RESULT] Concours ${concoursNumber} not finished yet`)
      return null
    }

    const db = getDb()
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO promosport_archive
        (concours, match_idx, homeTeam, awayTeam, result,
         vote_home, vote_draw, vote_away, score_home, score_away, date, is_finished, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `)

    const tx = db.transaction(() => {
      for (const m of grid.matches) {
        if (!m.result || m.result === 'N') continue
        upsert.run(
          String(concoursNumber),
          m.idx,
          m.home.toUpperCase(),
          m.away.toUpperCase(),
          m.result,
          m.publicVote?.p1 || null,
          m.publicVote?.px || null,
          m.publicVote?.p2 || null,
          m.scoreHome || null,
          m.scoreAway || null,
          new Date().toISOString().slice(0, 10)
        )
      }
    })
    tx()
    db.close()

    logger.info(
      `[PROMOSPORT-RESULT] Fetched ${finishedMatches.length} results for concours ${concoursNumber}`
    )
    return finishedMatches
  } catch (e) {
    logger.error(
      `[PROMOSPORT-RESULT] checkAndFetchResults error for ${concoursNumber}: ${e.message}`
    )
    return null
  }
}

function computeAccuracy(concoursNumber) {
  try {
    const db = getDb()
    const predictions = db
      .prepare(
        `
      SELECT pp.*, pa.result, pa.score_home, pa.score_away
      FROM promosport_predictions pp
      LEFT JOIN promosport_archive pa
        ON pp.concours = pa.concours
        AND pp.match_idx = pa.match_idx
      WHERE pp.concours = ? AND pa.result IS NOT NULL AND pa.result != 'N'
    `
      )
      .all(String(concoursNumber))
    db.close()

    if (predictions.length === 0) return null

    const byGrid = {}
    let totalCorrect = 0
    let totalMatches = 0

    for (const p of predictions) {
      if (!byGrid[p.grid_name]) byGrid[p.grid_name] = { correct: 0, total: 0, matchDetails: [] }
      const choices = JSON.parse(p.choices || '[]')
      const isCorrect = choices.includes(p.result)
      byGrid[p.grid_name].total++
      byGrid[p.grid_name].correct += isCorrect ? 1 : 0
      byGrid[p.grid_name].matchDetails.push({
        match_idx: p.match_idx,
        home: p.home_team,
        away: p.away_team,
        choices,
        result: p.result,
        score: p.score_home != null ? `${p.score_home}-${p.score_away}` : null,
        isCorrect,
      })
      totalCorrect += isCorrect ? 1 : 0
      totalMatches++
    }

    const gridStats = Object.entries(byGrid).map(([name, data]) => ({
      name,
      accuracy: ((data.correct / data.total) * 100).toFixed(1) + '%',
      correct: data.correct,
      total: data.total,
      matchDetails: data.matchDetails,
    }))

    return {
      concours: String(concoursNumber),
      totalMatches,
      totalCorrect,
      overallAccuracy: ((totalCorrect / totalMatches) * 100).toFixed(1) + '%',
      grids: gridStats,
    }
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] computeAccuracy error: ${e.message}`)
    return null
  }
}

function getRecentHistory(limit = 20) {
  try {
    const db = getDb()
    const concours = db
      .prepare(
        `
      SELECT DISTINCT pp.concours FROM promosport_predictions pp
      ORDER BY pp.concours DESC LIMIT ?
    `
      )
      .all(limit)
      .map((r) => r.concours)
    db.close()
    return concours
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] getRecentHistory error: ${e.message}`)
    return []
  }
}

function getOverallStats() {
  try {
    const db = getDb()

    // Check if predictions table exists and has data
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='promosport_predictions'`
      )
      .get()
    if (!tables) {
      db.close()
      // Fallback: return crowd-based accuracy from archive
      const archiveStats = db
        .prepare(
          `SELECT COUNT(*) as total FROM promosport_archive WHERE result IS NOT NULL AND result != 'N'`
        )
        .get()
      if (!archiveStats || archiveStats.total === 0) {
        db.close()
        return null
      }
      db.close()
      return {
        concoursCount: 0,
        totalMatches: 0,
        totalCorrect: 0,
        overallAccuracy: '0.0%',
        perGrid: [],
        recentConcours: [],
      }
    }

    const concoursList = db
      .prepare(
        `
      SELECT DISTINCT pp.concours FROM promosport_predictions pp
      INNER JOIN promosport_archive pa ON pp.concours = pa.concours AND pa.is_finished = 1
    `
      )
      .all()
      .map((r) => r.concours)
    db.close()

    if (concoursList.length === 0) {
      return {
        concoursCount: 0,
        totalMatches: 0,
        totalCorrect: 0,
        overallAccuracy: '0.0%',
        perGrid: [],
        recentConcours: [],
      }
    }

    const accuracies = concoursList.map((c) => computeAccuracy(c)).filter(Boolean)
    if (accuracies.length === 0) {
      return {
        concoursCount: 0,
        totalMatches: 0,
        totalCorrect: 0,
        overallAccuracy: '0.0%',
        perGrid: [],
        recentConcours: [],
      }
    }

    const totalCorrect = accuracies.reduce((s, a) => s + a.totalCorrect, 0)
    const totalMatches = accuracies.reduce((s, a) => s + a.totalMatches, 0)
    const gridAverages = {}
    for (const acc of accuracies) {
      for (const g of acc.grids) {
        if (!gridAverages[g.name]) gridAverages[g.name] = { correct: 0, total: 0 }
        gridAverages[g.name].correct += g.correct
        gridAverages[g.name].total += g.total
      }
    }

    return {
      concoursCount: accuracies.length,
      totalMatches,
      totalCorrect,
      overallAccuracy: ((totalCorrect / totalMatches) * 100).toFixed(1) + '%',
      perGrid: Object.entries(gridAverages).map(([name, data]) => ({
        name,
        accuracy: ((data.correct / data.total) * 100).toFixed(1) + '%',
        correct: data.correct,
        total: data.total,
      })),
      recentConcours: accuracies.slice(-10).map((a) => ({
        concours: a.concours,
        accuracy: a.overallAccuracy,
        correct: a.totalCorrect,
        total: a.totalMatches,
      })),
    }
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] getOverallStats error: ${e.message}`)
    return null
  }
}

function getConfusionMatrix() {
  try {
    const db = getDb()
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='promosport_predictions'`
      )
      .get()
    if (!tables) {
      db.close()
      return null
    }
    const rows = db
      .prepare(
        `
      SELECT pp.choices, pa.result
      FROM promosport_predictions pp
      INNER JOIN promosport_archive pa
        ON pp.concours = pa.concours AND pp.match_idx = pa.match_idx
      WHERE pa.result IS NOT NULL AND pa.result != 'N'
    `
      )
      .all()
    db.close()

    if (rows.length === 0) return null

    const matrix = { 1: { 1: 0, X: 0, 2: 0 }, X: { 1: 0, X: 0, 2: 0 }, 2: { 1: 0, X: 0, 2: 0 } }
    const predictedDist = { 1: 0, X: 0, 2: 0 }
    let total = 0,
      correct = 0

    for (const r of rows) {
      const choices = JSON.parse(r.choices || '[]')
      const result = r.result
      if (!matrix[result]) continue
      if (choices.length === 1) {
        const pred = choices[0]
        matrix[result][pred]++
        predictedDist[pred]++
        total++
        if (pred === result) correct++
      } else {
        // Double/triple: pick most confident or first
        const pred = choices[0]
        matrix[result][pred] += 0.5
        predictedDist[pred] += 0.5
        total += 0.5
        if (choices.includes(result)) correct++
      }
    }

    return {
      totalPredictions: rows.length,
      totalSimple: total,
      correct,
      accuracy: ((correct / total) * 100).toFixed(1) + '%',
      matrix,
      predictedDistribution: predictedDist,
      byResult: Object.entries(matrix).map(([actual, preds]) => ({
        actual,
        total: Object.values(preds).reduce((s, v) => s + v, 0),
        correct: preds[actual],
        precision: (preds[actual] / Object.values(preds).reduce((s, v) => s + v, 0)) * 100 || 0,
        distribution: preds,
      })),
    }
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] getConfusionMatrix error: ${e.message}`)
    return null
  }
}

function simulateROI(stakePerMatch = 10) {
  try {
    const db = getDb()
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='promosport_predictions'`
      )
      .get()
    if (!tables) {
      db.close()
      return null
    }
    const rows = db
      .prepare(
        `
      SELECT pp.choices, pa.result, pa.match_idx, pp.grid_name, pp.concours
      FROM promosport_predictions pp
      INNER JOIN promosport_archive pa
        ON pp.concours = pa.concours AND pp.match_idx = pa.match_idx
      WHERE pa.result IS NOT NULL AND pa.result != 'N'
      ORDER BY pp.concours ASC
    `
      )
      .all()
    db.close()

    if (rows.length === 0) return null

    const odds = { 1: 2.5, X: 3.2, 2: 2.8 }
    let totalStaked = 0,
      totalReturned = 0,
      wins = 0,
      losses = 0
    const byGrid = {}
    const byConcours = {}

    for (const r of rows) {
      const choices = JSON.parse(r.choices || '[]')
      if (choices.length !== 1) continue

      const stake = stakePerMatch
      totalStaked += stake
      totalReturned += choices[0] === r.result ? stake * odds[choices[0]] : 0
      if (choices[0] === r.result) wins++
      else losses++

      if (!byGrid[r.grid_name]) byGrid[r.grid_name] = { staked: 0, returned: 0, wins: 0, losses: 0 }
      byGrid[r.grid_name].staked += stake
      byGrid[r.grid_name].returned += choices[0] === r.result ? stake * odds[choices[0]] : 0
      byGrid[r.grid_name].wins += choices[0] === r.result ? 1 : 0
      byGrid[r.grid_name].losses += choices[0] !== r.result ? 1 : 0

      if (!byConcours[r.concours]) byConcours[r.concours] = { staked: 0, returned: 0 }
      byConcours[r.concours].staked += stake
      byConcours[r.concours].returned += choices[0] === r.result ? stake * odds[choices[0]] : 0
    }

    const roi = totalStaked > 0 ? ((totalReturned - totalStaked) / totalStaked) * 100 : 0

    return {
      totalBets: wins + losses,
      wins,
      losses,
      winRate: ((wins / (wins + losses)) * 100).toFixed(1) + '%',
      totalStaked,
      totalReturned,
      profit: totalReturned - totalStaked,
      roi: roi.toFixed(1) + '%',
      byGrid: Object.entries(byGrid).map(([name, d]) => ({
        name,
        staked: d.staked,
        returned: d.returned,
        profit: d.returned - d.staked,
        roi: d.staked > 0 ? (((d.returned - d.staked) / d.staked) * 100).toFixed(1) + '%' : '0%',
        wins: d.wins,
        losses: d.losses,
      })),
      byConcours: Object.entries(byConcours).map(([c, d]) => ({
        concours: c,
        staked: d.staked,
        returned: d.returned,
        profit: d.returned - d.staked,
      })),
    }
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] simulateROI error: ${e.message}`)
    return null
  }
}

function shouldAutoRetrain() {
  try {
    const flag = process.env.ENABLE_AUTO_RETRAIN
    return flag !== 'false' && flag !== '0'
  } catch (_) {
    return true
  }
}

function triggerAutoRetrain() {
  if (!shouldAutoRetrain()) {
    logger.info('[PROMOSPORT-RESULT] Auto-retrain disabled via ENABLE_AUTO_RETRAIN=false')
    return
  }
  logger.info('[PROMOSPORT-RESULT] Triggering auto-retrain after new results...')
  try {
    import { execSync } from 'child_process'
    import path from 'path'
    const scriptsDir = path.join(__dirname, '..', 'scripts')
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

    // Import data to include new results
    execSync(`${pythonCmd} "${path.join(scriptsDir, 'import_promosport_archive.py')}"`, {
      timeout: 60000,
      encoding: 'utf8',
      windowsHide: true,
    })

    // Train with rollback
    const trainOut = execSync(
      `${pythonCmd} "${path.join(scriptsDir, 'train_promosport_xgboost.py')}"`,
      { timeout: 600000, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }
    )

    // Backfill predictions
    try {
      const { backfillPredictions } = await import(
        path.join(scriptsDir, 'backfill_promosport_predictions.js')
      )
      backfillPredictions()
    } catch (_) {}

    // Reload model
    import mlService from './promosportMLService'
    mlService.reloadModel()

    // Notify
    const accMatch = trainOut.match(/Accuracy: ([\d.]+)%/)
    const llMatch = trainOut.match(/Log Loss: ([\d.]+)/)
    const rbMatch = trainOut.match(/Rollback: old acc=([\d.]+)%.*new acc=([\d.]+)%/)
    import botService from './botService'
    let msg = `🔄 <b>Auto-Retrain (nouveaux résultats)</b>\nAccuracy: ${accMatch ? accMatch[1] + '%' : 'N/A'}\nLog Loss: ${llMatch ? llMatch[1] : 'N/A'}`
    if (rbMatch) msg += `\n⚠️ Rollback: ancien ${rbMatch[1]}% > nouveau ${rbMatch[2]}%`
    botService.sendAlert(msg)

    logger.info(
      `[PROMOSPORT-RESULT] Auto-retrain complete — acc: ${accMatch ? accMatch[1] + '%' : 'N/A'}`
    )
  } catch (e) {
    logger.error(`[PROMOSPORT-RESULT] Auto-retrain failed: ${e.message}`)
    // Restore backup
    try {
      import fs from 'fs'
      const backup = path.join(__dirname, '..', 'models', 'promosport_xgb.backup.json')
      const model = path.join(__dirname, '..', 'models', 'promosport_xgb.json')
      if (fs.existsSync(backup)) fs.copyFileSync(backup, model)
    } catch (_) {}
  }
}

async function checkAndFetchResultsWithAutoRetrain(concoursNumber) {
  const results = await checkAndFetchResults(concoursNumber)
  if (results && results.length > 0) {
    // Trigger auto-retrain asynchronously
    setImmediate(() => triggerAutoRetrain())
  }
  return results
}

export = {
  storePrediction,
  checkAndFetchResults,
  checkAndFetchResultsWithAutoRetrain,
  computeAccuracy,
  getRecentHistory,
  getOverallStats,
  getConfusionMatrix,
  simulateROI,
  triggerAutoRetrain,
  backfillPredictions: () => {
    try {
      return require('../scripts/backfill_promosport_predictions').backfillPredictions()
    } catch (e) {
      logger.error(`[PROMOSPORT-RESULT] backfillPredictions: ${e.message}`)
      return { total: 0, stored: 0 }
    }
  },
}
