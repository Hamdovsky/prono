/**
 * scrape_footballdata.js — Scrape les cotes depuis football-data.co.uk
 *
 * Usage: node scripts/scrape_footballdata.js
 *
 * Sources: football-data.co.uk (CSV publics, 100% gratuit)
 * Couverture: ~25 ligues mondiales
 */

const fs = require('fs')
const path = require('path')

const FootballDataScraper = require('../services/scrapers/FootballDataScraper')

const BASE_DIR = path.resolve(__dirname, '..', '..')
const OUTPUT_FILE = path.join(BASE_DIR, 'data', 'football_data_odds.json')

const LEAGUES = ['E0', 'E1', 'D1', 'I1', 'SP1', 'F1', 'N1', 'P1', 'B1']

async function scrapeAll() {
  console.log('[scrape_footballdata] Starting...')

  const allOdds = {}

  for (const league of LEAGUES) {
    try {
      const data = await FootballDataScraper.getOddsForLeague(league)
      if (data && data.length > 0) {
        const leagueName = FootballDataScraper.getLeagueName(league)
        allOdds[league] = {
          name: leagueName,
          code: league,
          matches: data,
          count: data.length,
        }
        console.log(`  [OK] ${leagueName}: ${data.length} matches`)
      } else {
        console.log(`  [--] ${league}: no data`)
      }
    } catch (e) {
      console.log(`  [ERR] ${league}: ${e.message}`)
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allOdds, null, 2), 'utf8')
  console.log(`\n[s scrape_footballdata] Saved to ${OUTPUT_FILE}`)

  const total = Object.values(allOdds).reduce((sum, l) => sum + l.count, 0)
  console.log(`Total: ${Object.keys(allOdds).length} leagues, ${total} matches`)

  return allOdds
}

scrapeAll()
  .then((data) => {
    const leagues = Object.keys(data)
    console.log('\n=== AVAILABLE LEAGUES ===')
    leagues.forEach((l) => {
      const d = data[l]
      console.log(`${d.name} (${l}): ${d.count} matches`)
    })

    const allMatches = []
    Object.values(data).forEach((l) => {
      l.matches.slice(0, 3).forEach((m) => {
        allMatches.push({
          league: l.name,
          home: m.HomeTeam,
          away: m.AwayTeam,
          date: m.Date,
          score: `${m.FTHG}-${m.FTAG}`,
          odds: {
            home: parseFloat(m.AvgH),
            draw: parseFloat(m.AvgD),
            away: parseFloat(m.AvgA),
            over25: parseFloat(m['Avg>2.5']),
            under25: parseFloat(m['Avg<2.5']),
          },
        })
      })
    })

    console.log('\n=== SAMPLE MATCHES ===')
    allMatches.slice(0, 10).forEach((m) => {
      const o = m.odds
      console.log(`${m.home} vs ${m.away} [${m.league}]`)
      console.log(`  ${m.score} | ${m.date}`)
      if (o.home) console.log(`  1=${o.home} X=${o.draw} 2=${o.away} | O/U=${o.over25}/${o.under25}`)
    })

    process.exit(0)
  })
  .catch((e) => {
    console.error('[scrape_footballdata] Error:', e.message)
    process.exit(1)
  })
