const axios = require('axios')
const path = require('path')
const Database = require('better-sqlite3')
const Bottleneck = require('bottleneck')
const logger = require('../core/logger')

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'historical_archive.sqlite')

const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1100,
})

function getArchiveDb() {
  try {
    const db = new Database(ARCHIVE_PATH, { readonly: false })
    db.pragma('journal_mode = WAL')
    return db
  } catch (e) {
    logger.warn(`[SPORTDB] Cannot open archive DB: ${e.message}`)
    return null
  }
}

class SportdbService {
  async _fetch(endpoint) {
    if (process.env.SPORTDB_ENABLED === 'false') return null
    const key = process.env.SPORTDB_API_KEY
    if (!key) {
      logger.warn('[SPORTDB] No API key')
      return null
    }
    try {
      const { data } = await axios.get(`https://api.sportdb.dev/api/flashscore${endpoint}`, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        timeout: 20000,
      })
      return data
    } catch (e) {
      if (e.response?.status === 429) {
        logger.warn('[SPORTDB] Rate limited (429), slowing down...')
        await new Promise((r) => setTimeout(r, 3000))
        return null
      }
      if (e.response?.status === 500) {
        logger.warn(`[SPORTDB] Server error (500) for ${endpoint}`)
        return null
      }
      logger.warn(`[SPORTDB] GET ${endpoint} failed: ${e.message}`)
      return null
    }
  }

  async listCountries() {
    return (await limiter.schedule(() => this._fetch('/football'))) || []
  }

  async listCompetitions(countrySlug, countryId) {
    return (
      (await limiter.schedule(() => this._fetch(`/football/${countrySlug}:${countryId}`))) || []
    )
  }

  async getCompetitionSeasons(countrySlug, countryId, compSlug, compId) {
    return await limiter.schedule(() =>
      this._fetch(`/football/${countrySlug}:${countryId}/${compSlug}:${compId}`)
    )
  }

  async getResults(countrySlug, countryId, compSlug, compId, season, page = 1) {
    return (
      (await limiter.schedule(() =>
        this._fetch(
          `/football/${countrySlug}:${countryId}/${compSlug}:${compId}/${season}/results?page=${page}`
        )
      )) || []
    )
  }

  async getMatchStats(eventId) {
    return await limiter.schedule(() => this._fetch(`/match/${eventId}/stats`))
  }

  parseStats(statsData) {
    const result = {
      home_xg: 0,
      away_xg: 0,
      home_xgot: 0,
      away_xgot: 0,
      home_possession: 50,
      away_possession: 50,
      home_shots: 0,
      away_shots: 0,
      home_shots_on_target: 0,
      away_shots_on_target: 0,
      home_corners: 0,
      away_corners: 0,
      home_yellow_cards: 0,
      away_yellow_cards: 0,
      home_red_cards: 0,
      away_red_cards: 0,
      home_fouls: 0,
      away_fouls: 0,
      home_shots_inside_box: 0,
      away_shots_inside_box: 0,
      home_big_chances: 0,
      away_big_chances: 0,
      stats_blob: '{}',
    }
    if (!statsData || !Array.isArray(statsData)) return result
    const matchStats = statsData.find((s) => s.period === 'Match')
    if (!matchStats) return result
    const stats = {}
    for (const s of matchStats.stats) {
      stats[s.statName.toLowerCase().replace(/[^a-z0-9]/g, '_')] = {
        home: s.homeValue,
        away: s.awayValue,
      }
    }
    const f = (key, homeKey, awayKey) => {
      const entry = stats[key]
      if (!entry) return
      const h = parseFloat(entry.home)
      const a = parseFloat(entry.away)
      if (!isNaN(h)) result[homeKey] = h
      if (!isNaN(a)) result[awayKey] = a
    }
    f('expected_goals_xg', 'home_xg', 'away_xg')
    f('xg_on_target_xgot', 'home_xgot', 'away_xgot')
    f('ball_possession', 'home_possession', 'away_possession')
    f('total_shots', 'home_shots', 'away_shots')
    f('shots_on_target', 'home_shots_on_target', 'away_shots_on_target')
    f('corner_kicks', 'home_corners', 'away_corners')
    f('yellow_cards', 'home_yellow_cards', 'away_yellow_cards')
    f('red_cards', 'home_red_cards', 'away_red_cards')
    f('fouls', 'home_fouls', 'away_fouls')
    f('shots_inside_the_box', 'home_shots_inside_box', 'away_shots_inside_box')
    f('big_chances', 'home_big_chances', 'away_big_chances')
    result.stats_blob = JSON.stringify({
      yellow_cards_home: result.home_yellow_cards,
      yellow_cards_away: result.away_yellow_cards,
      red_cards_home: result.home_red_cards,
      red_cards_away: result.away_red_cards,
    })
    return result
  }

  mapResultToArchive(match, stats) {
    const homeScore = parseInt(match.homeScore) || 0
    const awayScore = parseInt(match.awayScore) || 0
    let result = 'D'
    if (homeScore > awayScore) result = 'H'
    else if (awayScore > homeScore) result = 'A'
    return {
      sofascore_id: match.eventId,
      startTimestamp: parseInt(match.startUtime) || 0,
      tournament_name: match.tournamentName || '',
      homeTeam: match.homeName || match.homeFirstName || '',
      awayTeam: match.awayName || match.awayFirstName || '',
      scoreHome: homeScore,
      scoreAway: awayScore,
      stats_blob: stats.stats_blob,
      home_xg: stats.home_xg,
      away_xg: stats.away_xg,
      home_possession: stats.home_possession,
      away_possession: stats.away_possession,
      home_shots: stats.home_shots,
      away_shots: stats.away_shots,
      home_shots_on_target: stats.home_shots_on_target,
      away_shots_on_target: stats.away_shots_on_target,
      home_corners: stats.home_corners,
      away_corners: stats.away_corners,
      home_fouls: stats.home_fouls,
      away_fouls: stats.away_fouls,
      result,
      archived_at: Date.now(),
    }
  }

  async discoverLeagues() {
    const countries = await this.listCountries()
    const targets = [
      'england',
      'spain',
      'italy',
      'germany',
      'france',
      'netherlands',
      'portugal',
      'belgium',
      'turkey',
      'brazil',
      'argentina',
      'usa',
    ]
    const leagues = []

    for (const country of countries) {
      const name = country.name?.toLowerCase().replace(/[^a-z]/g, '') || country.slug
      if (!targets.some((t) => name.includes(t))) continue

      const comps = await this.listCompetitions(country.slug, country.id)
      const topLeagues = {
        england: ['premier-league'],
        spain: ['laliga'],
        italy: ['serie-a'],
        germany: ['bundesliga'],
        france: ['ligue-1'],
        netherlands: ['eredivisie'],
        portugal: ['portugal-liga-portugal', 'primeira-liga'],
        belgium: ['jupiler-pro-league', 'pro-league'],
        turkey: ['super-lig'],
        brazil: ['brasileirao-serie-a', 'serie-a'],
        argentina: ['primera-division', 'liga-profesional'],
        usa: ['mls'],
      }

      const targetSlugs = Object.entries(topLeagues).find(([k]) => name.includes(k))?.[1] || []
      for (const comp of comps) {
        if (targetSlugs.some((s) => comp.slug === s || comp.slug?.includes(s))) {
          leagues.push({
            country: country.slug,
            countryId: country.id,
            comp: comp.slug,
            compId: comp.id,
          })
        }
      }
    }
    return leagues
  }

  async importLeagueHistory(country, cId, comp, compId, season, maxPages = 3) {
    const compData = await this.getCompetitionSeasons(country, cId, comp, compId)
    if (!compData || !compData.seasons) return 0
    const seasonData = compData.seasons.find((s) => s.season === season)
    if (!seasonData) return 0

    const db = getArchiveDb()
    let imported = 0

    for (let page = 1; page <= maxPages; page++) {
      const results = await this.getResults(country, cId, comp, compId, season, page)
      if (!results || results.length === 0) break
      logger.info(`[SPORTDB] ${comp} ${season} page ${page} (${results.length})`)

      for (const match of results) {
        const eventId = match.eventId
        if (!eventId) continue
        if (db && db.prepare('SELECT id FROM archive_matches WHERE sofascore_id = ?').get(eventId))
          continue

        const statsData = await this.getMatchStats(eventId)
        if (!statsData) continue

        const stats = this.parseStats(statsData)
        const record = this.mapResultToArchive(match, stats)

        if (db) {
          db.prepare(
            `
            INSERT OR IGNORE INTO archive_matches (
              sofascore_id, startTimestamp, tournament_name,
              homeTeam, awayTeam, scoreHome, scoreAway,
              stats_blob, home_xg, away_xg,
              home_possession, away_possession,
              home_shots, away_shots,
              home_shots_on_target, away_shots_on_target,
              home_corners, away_corners,
              home_fouls, away_fouls,
              result, archived_at
            ) VALUES (
              @sofascore_id, @startTimestamp, @tournament_name,
              @homeTeam, @awayTeam, @scoreHome, @scoreAway,
              @stats_blob, @home_xg, @away_xg,
              @home_possession, @away_possession,
              @home_shots, @away_shots,
              @home_shots_on_target, @away_shots_on_target,
              @home_corners, @away_corners,
              @home_fouls, @away_fouls,
              @result, @archived_at
            )
          `
          ).run(record)
        }
        imported++
      }
    }

    if (db && db.open) db.close()
    logger.info(`[SPORTDB] Imported ${imported} from ${comp} ${season}`)
    return imported
  }

  async importAllMajorLeagues(maxPages = 3) {
    const leagues = await this.discoverLeagues()
    const seasons = ['2025-2026', '2024-2025', '2023-2024']
    let total = 0
    for (const { country, countryId, comp, compId } of leagues) {
      for (const season of seasons) {
        total += await this.importLeagueHistory(country, countryId, comp, compId, season, maxPages)
      }
    }
    logger.info(`[SPORTDB] Total imported: ${total}`)
    return total
  }
}

module.exports = new SportdbService()
