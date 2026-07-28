const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

const TREND_PATH = path.join(__dirname, '..', 'data', 'promosport_accuracy_trend.json')

function loadTrend() {
  try {
    if (fs.existsSync(TREND_PATH)) {
      return JSON.parse(fs.readFileSync(TREND_PATH, 'utf8'))
    }
  } catch (_) {}
  return []
}

function saveSnapshot() {
  try {
    const promosportResultService = require('../services/promosportResultService')
    const stats = promosportResultService.getOverallStats()
    const crowd = promosportResultService.getCrowdStats
      ? promosportResultService.getCrowdStats()
      : null
    const matrix = promosportResultService.getConfusionMatrix()

    const snapshots = loadTrend()
    const entry = {
      date: new Date().toISOString().slice(0, 10),
      timestamp: Date.now(),
      accuracy: stats ? parseFloat(stats.overallAccuracy) : null,
      correct: stats ? stats.totalCorrect : 0,
      total: stats ? stats.totalMatches : 0,
      concoursCount: stats ? stats.concoursCount : 0,
      logLoss: null,
      crowdAccuracy: crowd ? (crowd.crowdAccuracy ? parseFloat(crowd.crowdAccuracy) : null) : null,
    }

    // Try to get log loss from model metadata
    try {
      const modelPath = path.join(__dirname, '..', 'models', 'promosport_logloss.txt')
      if (fs.existsSync(modelPath)) {
        entry.logLoss = parseFloat(fs.readFileSync(modelPath, 'utf8').trim())
      }
    } catch (_) {}

    // Keep last 365 entries
    snapshots.push(entry)
    while (snapshots.length > 365) snapshots.shift()

    fs.writeFileSync(TREND_PATH, JSON.stringify(snapshots, null, 2), 'utf8')
    logger.info(`[ACC-SNAPSHOT] Saved: accuracy=${entry.accuracy}% total=${entry.total}`)

    // Alert on drift
    const recent = snapshots.slice(-7).filter((s) => s.accuracy !== null)
    if (recent.length >= 3) {
      const avgAcc = recent.reduce((s, e) => s + e.accuracy, 0) / recent.length
      if (avgAcc < 30) {
        try {
          const botService = require('../services/botService')
          botService.sendAlert(
            `⚠️ <b>Dérive Promosport</b>\nAccuracy moyenne 7j: ${avgAcc.toFixed(1)}%\nSeuil critique: <30%\nSnapshot: ${entry.accuracy}% (${entry.correct}/${entry.total})`
          )
        } catch (_) {}
      }
      if (entry.logLoss !== null && entry.logLoss > 1.5) {
        try {
          const botService = require('../services/botService')
          botService.sendAlert(
            `⚠️ <b>Log Loss élevé</b>\nLog Loss: ${entry.logLoss}\nSeuil: >1.5\nSnapshot: ${entry.accuracy}% (${entry.correct}/${entry.total})`
          )
        } catch (_) {}
      }
    }

    return entry
  } catch (e) {
    logger.error(`[ACC-SNAPSHOT] Error: ${e.message}`)
    return null
  }
}

if (require.main === module) {
  saveSnapshot()
}

module.exports = { saveSnapshot, loadTrend }
