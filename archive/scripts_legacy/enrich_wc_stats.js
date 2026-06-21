/**
 * Enrich imported World Cup / Club World Cup matches with Sofascore stats
 * Usage: node scripts/enrich_wc_stats.js
 */
const { fetchWithRetry } = require('../SofascoreScraping/src/apiClient')
const Database = require('better-sqlite3')
const path = require('path')

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')
const WAIT_MS = 1500

// Tournament IDs on Sofascore
const TOURNAMENT_IDS = {
  'FIFA Club World Cup': 389,     // Club World Cup
  'World Cup 2026': 3089,         // World Cup
}

async function searchSofascore(team1, team2, dateStr) {
  try {
    // Search for the match via Sofascore unique-tournament/season/round approach
    // First, search for the event by team name
    const searchUrl = `https://api.sofascore.com/api/v1/search/teams/${encodeURIComponent(team1)}`
    const data = await fetchWithRetry(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/',
      }
    })
    const teams = data?.results || []
    if (teams.length === 0) return null
    
    // Get events for the first matching team
    const teamId = teams[0].entity?.id
    if (!teamId) return null
    
    const eventsUrl = `https://api.sofascore.com/api/v1/team/${teamId}/events?page=0&pageSize=50`
    const eventsData = await fetchWithRetry(eventsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/',
      }
    })
    
    const events = eventsData?.events || []
    for (const ev of events) {
      const homeTeam = ev.homeTeam?.name || ''
      const awayTeam = ev.awayTeam?.name || ''
      const evDate = ev.startDate || ''
      
      if ((homeTeam.includes(team1) || homeTeam.includes(team2) || 
           awayTeam.includes(team1) || awayTeam.includes(team2)) &&
          evDate.startsWith(dateStr.slice(0, 10))) {
        return ev
      }
    }
    return null
  } catch (e) {
    console.error(`  [ERR] Search failed: ${e.message}`)
    return null
  }
}

async function getMatchStats(eventId) {
  try {
    const url = `https://api.sofascore.com/api/v1/event/${eventId}/statistics`
    const data = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/',
      }
    })
    return data?.statistics || null
  } catch (e) {
    return null
  }
}

async function getMatchOdds(eventId) {
  try {
    const url = `https://api.sofascore.com/api/v1/event/${eventId}/odds/1`
    const data = await fetchWithRetry(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Origin': 'https://www.sofascore.com',
        'Referer': 'https://www.sofascore.com/',
      }
    })
    return data?.odds || null
  } catch (e) {
    return null
  }
}

function parseStats(statistics) {
  if (!statistics || !Array.isArray(statistics)) return {}
  
  const stats = {}
  for (const group of statistics) {
    const items = group.groups || group.items || []
    for (const item of items) {
      if (item.name && item.home != null && item.away != null) {
        stats[item.name] = { home: parseFloat(item.home), away: parseFloat(item.away) }
      }
    }
  }
  return stats
}

async function enrichMatch(row) {
  const homeTeam = row.homeTeam
  const awayTeam = row.awayTeam
  const dateStr = (row.match_date || '').split(' ')[0]
  
  console.log(`  Looking up: ${homeTeam} vs ${awayTeam} (${dateStr})`)
  
  // Search for the event
  const event = await searchSofascore(homeTeam, awayTeam, dateStr)
  if (!event) {
    console.log(`  -> Not found on Sofascore`)
    return false
  }
  
  const eventId = event.id
  console.log(`  -> Found event ${eventId}: ${event.homeTeam?.name} vs ${event.awayTeam?.name}`)
  
  // Get stats
  const statistics = await getMatchStats(eventId)
  const parsed = parseStats(statistics)
  
  // Get odds
  const odds = await getMatchOdds(eventId)
  
  // Update archive_matches
  const statsBlob = JSON.stringify(parsed)
  const oddsHome = odds?.[0]?.home || null
  const oddsDraw = odds?.[0]?.draw || null  
  const oddsAway = odds?.[0]?.away || null
  
  db.prepare(`UPDATE archive_matches SET 
    stats_blob = ?, odds_home = ?, odds_draw = ?, odds_away = ?, sofascore_id = ?
    WHERE id = ?`).run(statsBlob, oddsHome, oddsDraw, oddsAway, eventId, row.id)
  
  console.log(`  -> Updated stats (${Object.keys(parsed).length} metrics), odds=${oddsHome}/${oddsDraw}/${oddsAway}`)
  return true
}

async function main() {
  const db = new Database(ARCHIVE_PATH, { readonly: false })
  
  // Get matches from World Cup and Club World Cup without stats
  const targets = db.prepare(`
    SELECT id, homeTeam, awayTeam, match_date, league 
    FROM archive_matches 
    WHERE league IN ('FIFA Club World Cup', 'World Cup 2026')
    AND (stats_blob IS NULL OR stats_blob = '[]' OR stats_blob = '{}')
    ORDER BY match_date DESC
  `).all()
  
  console.log(`Found ${targets.length} matches to enrich\n`)
  
  let success = 0
  for (let i = 0; i < targets.length; i++) {
    console.log(`[${i+1}/${targets.length}]`)
    const ok = await enrichMatch(targets[i])
    if (ok) success++
    await new Promise(r => setTimeout(r, WAIT_MS))
  }
  
  console.log(`\nDone: ${success}/${targets.length} enriched`)
  db.close()
}

// Store db reference for enrichMatch
const db = new Database(ARCHIVE_PATH, { readonly: false })
main().catch(console.error).finally(() => db.close())
