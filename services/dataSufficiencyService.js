/**
 * dataSufficiencyService.js — Data Sufficiency Score per market.
 *
 * Appelle le module Python data_pipeline/sources/data_sufficiency.py
 * pour calculer un score 0-100 de qualité des données par marché.
 *
 * Intégration : topPicksEngine.js vérifie le blue_band avant d'afficher un pick.
 *
 * Blue Band thresholds :
 *   >= 75 : HIGH  → BLUE BAND displayed
 *   50-74: MEDIUM → BLUE BAND with warning
 *   < 50 : LOW    → NO BLUE BAND (no pick)
 */
const { spawn } = require('child_process')
const path = require('path')
const logger = require('../core/logger')

const PYTHON = process.env.PYTHON_BIN || 'python'
const DATA_PIPELINE_DIR = path.join(__dirname, '..', 'data_pipeline')

const BLUE_BAND_THRESHOLD_HIGH = 75
const BLUE_BAND_THRESHOLD_MEDIUM = 50

const MARKETS = ['1X2', 'over_under', 'btts', 'corners', 'cards']


function parseMarketSufficiency(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}


function _scoreHistoricalFromCounts(homeCount, awayCount) {
  const minCount = Math.min(homeCount, awayCount)
  if (minCount === 0) return { score: 0, reasons: ['No historical data available'] }
  if (minCount <= 2) return { score: 5, reasons: [`Very few recent matches (home=${homeCount}, away=${awayCount})`] }
  if (minCount <= 5) return { score: 15, reasons: [`Few recent matches (home=${homeCount}, away=${awayCount})`] }
  if (minCount <= 10) return { score: 25, reasons: [`Moderate match history (home=${homeCount}, away=${awayCount})`] }
  return { score: 30, reasons: [`Good match history (home=${homeCount}, away=${awayCount})`] }
}


function computeSufficiencySync(homeTeam, awayTeam, options = {}) {
  const {
    historicalMatches = null,
    h2hMatches = null,
    formData = null,
    dataSources = {},
    sourcesUsed = [],
  } = options

  const dataSourcesStr = JSON.stringify(dataSources || {})
  const sourcesUsedStr = JSON.stringify(sourcesUsed || [])

  const histArg = historicalMatches != null ? JSON.stringify(historicalMatches) : 'null'
  const h2hArg = h2hMatches != null ? JSON.stringify(h2hMatches) : 'null'
  const formArg = formData != null ? JSON.stringify(formData) : 'null'

  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(DATA_PIPELINE_DIR)})
from sources.data_sufficiency import compute_market_sufficiency, get_all_market_sufficiencies
import json

home = ${JSON.stringify(String(homeTeam || ''))}
away = ${JSON.stringify(String(awayTeam || ''))}
hist = ${histArg}
h2h = ${h2hArg}
form = ${formArg}
ds = ${dataSourcesStr}
su = ${sourcesUsedStr}

try:
    all_suf = get_all_market_sufficiencies(home, away, hist, h2h, form, ds, su)
    result = {
        k: {
            'score': float(v.score),
            'level': str(v.level.value),
            'blue_band': bool(v.blue_band),
            'reasons': list(v.reasons),
        }
        for k, v in all_suf.items()
    }
    print(json.dumps(result))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`
  return new Promise((resolve) => {
    const proc = spawn(PYTHON, ['-c', script], {
      cwd: DATA_PIPELINE_DIR,
      windowsHide: true,
      timeout: 30000,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0 || stderr.trim()) {
        logger.warn(`[DataSufficiency] Python error: ${stderr.trim().split('\n').slice(-1)[0]}`)
        resolve(null)
        return
      }
      const result = parseMarketSufficiency(stdout.trim())
      resolve(result)
    })
    proc.on('error', (err) => {
      logger.warn(`[DataSufficiency] Spawn error: ${err.message}`)
      resolve(null)
    })
  })
}


async function getMarketSufficiency(homeTeam, awayTeam, options = {}) {
  const result = await computeSufficiencySync(homeTeam, awayTeam, options)
  if (!result || result.error) return null

  const out = {}
  for (const market of MARKETS) {
    if (result[market]) {
      out[market] = {
        score: result[market].score,
        level: result[market].level,
        blueBand: result[market].blue_band,
        reasons: result[market].reasons || [],
      }
    }
  }
  return out
}


async function getFastSufficiencyScore(homeTeam, awayTeam, options = {}) {
  const { dataSources = {}, sourcesUsed = [] } = options
  const homeNorm = (homeTeam || '').toLowerCase().trim()
  const awayNorm = (awayTeam || '').toLowerCase().trim()

  let homeCount = 0, awayCount = 0
  try {
    const db = require('../core/database')
    const cutoff = Date.now() - 365 * 24 * 3600 * 1000
    const rows = db.prepare(`
      SELECT "homeTeam", "awayTeam" FROM historical_matches
      WHERE "startTimestamp" >= ? AND (
        ("homeTeam" = ? AND "awayTeam" = ?) OR
        ("homeTeam" = ? AND "awayTeam" = ?) OR
        ("homeTeam" = ? AND "awayTeam" = ?) OR
        ("homeTeam" = ? AND "awayTeam" = ?)
      )
    `).all(cutoff, homeNorm, awayNorm, awayNorm, homeNorm, homeTeam, awayTeam, awayTeam, homeTeam)
    homeCount = rows.filter(r =>
      r.homeTeam.toLowerCase() === homeNorm || r.awayTeam.toLowerCase() === homeNorm
    ).length
    awayCount = rows.filter(r =>
      r.homeTeam.toLowerCase() === awayNorm || r.awayTeam.toLowerCase() === awayNorm
    ).length
  } catch (e) {
    logger.debug(`[DataSufficiency] Fast count failed: ${e.message}`)
  }

  const hResult = _scoreHistoricalFromCounts(homeCount, awayCount)
  const sourceDivScore = sourcesUsed.length >= 2 ? 10 : sourcesUsed.length === 1 ? 5 : 0
  const xgScore = (dataSources.statsbomb_open_data || dataSources.modeled_xg) ? 25 :
                   (dataSources.football_data) ? 15 : 0
  const score = Math.min(100, hResult.score + sourceDivScore + xgScore)

  let level = 'low'
  if (score >= 75) level = 'high'
  else if (score >= 50) level = 'medium'

  return {
    score,
    level,
    blueBand: score >= 50,
    reasons: [...hResult.reasons, `Sources: ${sourcesUsed.join(',') || 'none'}`],
  }
}


function isBlueBandMatch(marketSufficiency) {
  if (!marketSufficiency || typeof marketSufficiency !== 'object') return false
  const scores = Object.values(marketSufficiency).map((m) => m.score || 0)
  if (!scores.length) return false
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length
  return avgScore >= BLUE_BAND_THRESHOLD_MEDIUM
}


function getPickBlueBand(marketSufficiency, marketType) {
  if (!marketSufficiency) return { blueBand: false, score: 0, level: 'low' }
  const m = marketSufficiency[marketType]
  if (!m) return { blueBand: false, score: 0, level: 'low' }
  return {
    blueBand: m.blueBand,
    score: m.score,
    level: m.level,
  }
}


module.exports = {
  getMarketSufficiency,
  getFastSufficiencyScore,
  isBlueBandMatch,
  getPickBlueBand,
  BLUE_BAND_THRESHOLD_HIGH,
  BLUE_BAND_THRESHOLD_MEDIUM,
  MARKETS,
}
