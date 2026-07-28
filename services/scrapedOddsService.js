const { query, usingPostgres } = require('../core/pg_connector')
const logger = require('../core/logger')

const TABLE = 'scraped_odds'
const MAX_AGE_MS = 12 * 60 * 60 * 1000

async function ensureTable() {
  if (!usingPostgres()) return false
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id SERIAL PRIMARY KEY,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        league TEXT,
        odds_home DECIMAL(10,4),
        odds_draw DECIMAL(10,4),
        odds_away DECIMAL(10,4),
        bookmaker TEXT DEFAULT 'scraper',
        source TEXT DEFAULT 'scraper',
        scraped_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(home_team, away_team, league, bookmaker)
      )
    `)
    logger.info('[SCRAPED_ODDS] Table ensured')
    return true
  } catch (e) {
    logger.error(`[SCRAPED_ODDS] Table init error: ${e.message}`)
    return false
  }
}

async function storeOdds(
  homeTeam,
  awayTeam,
  league,
  oddsHome,
  oddsDraw,
  oddsAway,
  bookmaker = 'scraper'
) {
  if (!usingPostgres()) return false
  try {
    await query(
      `INSERT INTO ${TABLE} (home_team, away_team, league, odds_home, odds_draw, odds_away, bookmaker, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scraper')
       ON CONFLICT (home_team, away_team, league, bookmaker)
       DO UPDATE SET odds_home = $4, odds_draw = $5, odds_away = $6, scraped_at = NOW()`,
      [homeTeam, awayTeam, league || 'Unknown', oddsHome, oddsDraw, oddsAway, bookmaker]
    )
    return true
  } catch (e) {
    logger.error(`[SCRAPED_ODDS] Store error: ${e.message}`)
    return false
  }
}

async function getLatestOdds(homeTeam, awayTeam, league) {
  if (!usingPostgres()) return null
  try {
    const rows = await query(
      `SELECT odds_home, odds_draw, odds_away, bookmaker, scraped_at
       FROM ${TABLE}
       WHERE home_team ILIKE $1 AND away_team ILIKE $2 AND league ILIKE $3
         AND scraped_at > NOW() - INTERVAL '12 hours'
       ORDER BY scraped_at DESC LIMIT 1`,
      [homeTeam, awayTeam, league || 'Unknown']
    )
    if (rows && rows.length > 0) return rows[0]
    return null
  } catch (e) {
    logger.error(`[SCRAPED_ODDS] Get error: ${e.message}`)
    return null
  }
}

async function getBulkOdds(leagues) {
  if (!usingPostgres() || !leagues || leagues.length === 0) return {}
  try {
    const placeholders = leagues.map((_, i) => `$${i + 1}`).join(',')
    const rows = await query(
      `SELECT home_team, away_team, league, odds_home, odds_draw, odds_away, scraped_at
       FROM ${TABLE}
       WHERE league ILIKE ANY(ARRAY[${placeholders}])
         AND scraped_at > NOW() - INTERVAL '12 hours'
       ORDER BY scraped_at DESC`,
      leagues
    )
    if (!rows) return {}
    const result = {}
    for (const r of rows) {
      const key = `${r.home_team}|${r.away_team}|${r.league}`
      if (!result[key]) result[key] = r
    }
    return result
  } catch (e) {
    logger.error(`[SCRAPED_ODDS] Bulk get error: ${e.message}`)
    return {}
  }
}

async function getStats() {
  if (!usingPostgres()) return { total: 0, lastScrape: null }
  try {
    const total = await query(`SELECT COUNT(*) as c FROM ${TABLE}`)
    const last = await query(`SELECT MAX(scraped_at) as last FROM ${TABLE}`)
    return {
      total: total?.[0]?.c || 0,
      lastScrape: last?.[0]?.last || null,
    }
  } catch (e) {
    return { total: 0, lastScrape: null, error: e.message }
  }
}

module.exports = { ensureTable, storeOdds, getLatestOdds, getBulkOdds, getStats }
