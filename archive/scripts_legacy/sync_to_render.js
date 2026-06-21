/**
 * Sync local upcoming matches to Render via /api/sync-matches
 */
require('dotenv').config()
const path = require('path')

// Force local database path
process.env.DATABASE_PATH = path.resolve(__dirname, '../data/tactical.db')
const database = require('../core/database')

const RENDER_SYNC_URL = 'https://prono-l5e3.onrender.com/api/sync-matches'

async function main() {
  console.log('📤 Reading upcoming matches from local DB...')

  const allMatches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS'])

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startMs = startOfToday.getTime()
  const endMs = startMs + 14 * 24 * 60 * 60 * 1000

  const upcoming = allMatches.filter(m => {
    let rawTs = m.startTimestamp
    if (!rawTs || rawTs === 0) {
      try {
        const data = typeof m.fullData === 'string' ? JSON.parse(m.fullData) : m.fullData
        if (data && data.startTimestamp) rawTs = data.startTimestamp
      } catch (_) {}
    }
    if (!rawTs || rawTs === 0) return false
    const tsMs = rawTs > 1e11 ? rawTs : rawTs * 1000
    return tsMs >= startMs && tsMs <= endMs
  })

  console.log(`📊 Found ${upcoming.length} upcoming matches to sync (today + 14 days)`)

  if (upcoming.length === 0) {
    console.log('❌ No upcoming matches to sync. Exiting.')
    process.exit(0)
  }

  // Prepare matches payload matching the INSERT OR REPLACE schema
  const matches = upcoming.map(m => ({
    id: String(m.id),
    homeTeam: m.homeTeam || '',
    awayTeam: m.awayTeam || '',
    league: m.league || 'Unknown',
    scoreHome: m.scoreHome || 0,
    scoreAway: m.scoreAway || 0,
    minute: String(m.minute || ''),
    status: String(m.status || 'scheduled'),
    prediction: m.prediction || null,
    confidence: parseFloat(m.confidence || 50),
    fullData: typeof m.fullData === 'string' ? m.fullData : JSON.stringify(m.fullData || m),
    timestamp: m.timestamp || new Date().toISOString(),
    startTimestamp: parseInt(m.startTimestamp || Math.floor(Date.now() / 1000)),
    possession_home: parseInt(m.possession_home || 0),
    possession_away: parseInt(m.possession_away || 0),
    dangerous_attacks_home: parseInt(m.dangerous_attacks_home || 0),
    dangerous_attacks_away: parseInt(m.dangerous_attacks_away || 0),
    shots_on_target_home: parseInt(m.shots_on_target_home || 0),
    shots_on_target_away: parseInt(m.shots_on_target_away || 0),
    corners_home: parseInt(m.corners_home || 0),
    corners_away: parseInt(m.corners_away || 0),
    source: m.source || 'sofascore',
    last_updated: parseInt(m.last_updated || Date.now()),
    home_win_probability: parseFloat(m.home_win_probability || 0),
    draw_probability: parseFloat(m.draw_probability || 0),
    away_win_probability: parseFloat(m.away_win_probability || 0),
    insufficient_data: parseInt(m.insufficient_data || 0),
    odds_home: parseFloat(m.odds_home || 0),
    odds_draw: parseFloat(m.odds_draw || 0),
    odds_away: parseFloat(m.odds_away || 0)
  }))

  console.log(`📦 Payload: ${matches.length} matches, ~${Math.round(JSON.stringify(matches).length / 1024)}KB`)

  try {
    const axios = require('axios')
    const response = await axios.post(RENDER_SYNC_URL, { matches }, {
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' }
    })
    console.log(`✅ Sync response:`, JSON.stringify(response.data))
  } catch (err) {
    console.error(`❌ Sync failed:`, err.message)
    if (err.response) {
      console.error(`   Status: ${err.response.status}`)
      console.error(`   Body:`, err.response.data)
    }
    process.exit(1)
  }

  console.log('✅ Sync complete! Check https://prono-l5e3.onrender.com/ in a few seconds.')
}

main().catch(e => { console.error(e); process.exit(1) })
