/**
 * eloRatingService.js — Elo rating system for club football
 *
 * Maintains per-team Elo ratings with:
 *   - K-factor = 32 (standard for club competitions)
 *   - Home advantage = 100 Elo points
 *   - Goal margin multiplier (wider wins = more points)
 *   - Cache in memory with optional DB persistence
 */

const CACHE_KEY = 'elo_ratings'
const DEFAULT_RATING = 1500
const K_FACTOR = 32
const HOME_ADVANTAGE = 100

let _ratings = {}
let _loaded = false

function _loadCache() {
  if (_loaded) return
  _loaded = true
  try {
    const db = require('../core/database')
    if (db && db.db) {
      const row = db.db.prepare('SELECT value FROM config_engine WHERE key = ?').get(CACHE_KEY)
      if (row && row.value) {
        _ratings = JSON.parse(row.value)
      }
    }
  } catch (e) {}
}

function _saveCache() {
  try {
    const db = require('../core/database')
    if (db && db.db) {
      db.db
        .prepare(
          'CREATE TABLE IF NOT EXISTS config_engine (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
        )
        .run()
      db.db
        .prepare(
          "INSERT INTO config_engine (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = datetime('now')"
        )
        .run(CACHE_KEY, JSON.stringify(_ratings))
    }
  } catch (e) {}
}

function _getRating(team) {
  if (!team) return DEFAULT_RATING
  return _ratings[team] || DEFAULT_RATING
}

function _expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))
}

function _goalMarginMultiplier(goalDiff) {
  if (goalDiff <= 1) return 1
  if (goalDiff === 2) return 1.5
  return (11 + goalDiff) / 8
}

function getRating(team) {
  _loadCache()
  return _getRating(team)
}

function getMatchRatings(homeTeam, awayTeam) {
  _loadCache()
  const homeRating = _getRating(homeTeam) + HOME_ADVANTAGE
  const awayRating = _getRating(awayTeam)
  const expectedHome = _expectedScore(homeRating, awayRating)
  const expectedAway = 1 - expectedHome
  return {
    homeRating: _getRating(homeTeam),
    awayRating: _getRating(awayTeam),
    homeAdvantage: HOME_ADVANTAGE,
    expectedHome: parseFloat(expectedHome.toFixed(4)),
    expectedAway: parseFloat(expectedAway.toFixed(4)),
    homeWinProb: parseFloat((expectedHome * 100).toFixed(1)),
    awayWinProb: parseFloat((expectedAway * 100).toFixed(1)),
  }
}

function updateRatings(homeTeam, awayTeam, scoreHome, scoreAway) {
  _loadCache()
  const homeRating = _getRating(homeTeam) + HOME_ADVANTAGE
  const awayRating = _getRating(awayTeam)
  const expectedHome = _expectedScore(homeRating, awayRating)
  const expectedAway = 1 - expectedHome

  let actualHome, actualAway
  if (scoreHome > scoreAway) {
    actualHome = 1
    actualAway = 0
  } else if (scoreHome === scoreAway) {
    actualHome = 0.5
    actualAway = 0.5
  } else {
    actualHome = 0
    actualAway = 1
  }

  const goalDiff = Math.abs(scoreHome - scoreAway)
  const marginMult = _goalMarginMultiplier(goalDiff)

  const kHome = K_FACTOR * marginMult
  const kAway = K_FACTOR * marginMult

  const newHome = _getRating(homeTeam) + kHome * (actualHome - expectedHome)
  const newAway = _getRating(awayTeam) + kAway * (actualAway - expectedAway)

  _ratings[homeTeam] = Math.round(newHome)
  _ratings[awayTeam] = Math.round(newAway)
  _saveCache()

  return {
    homeTeam,
    awayTeam,
    homeRatingBefore: _getRating(homeTeam) - Math.round(kHome * (actualHome - expectedHome)),
    awayRatingBefore: _getRating(awayTeam) - Math.round(kAway * (actualAway - expectedAway)),
    homeRatingAfter: _ratings[homeTeam],
    awayRatingAfter: _ratings[awayTeam],
    homeChange: Math.round(kHome * (actualHome - expectedHome)),
    awayChange: Math.round(kAway * (actualAway - expectedAway)),
  }
}

function getAllRatings() {
  _loadCache()
  const entries = Object.entries(_ratings)
    .map(([team, rating]) => ({ team, rating }))
    .sort((a, b) => b.rating - a.rating)
  return entries
}

module.exports = { getRating, getMatchRatings, updateRatings, getAllRatings }
