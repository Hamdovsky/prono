// @ts-nocheck
import { Pool } from 'pg'
import logger from '../core/logger'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
})

const MIN_MATCHES = 10

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS league_model_parameters (
      id SERIAL PRIMARY KEY,
      tournament_name TEXT NOT NULL,
      team_name TEXT,
      attack_rating REAL DEFAULT 0.0,
      defense_rating REAL DEFAULT 0.0,
      hfa REAL DEFAULT 0.25,
      rho REAL DEFAULT -0.12,
      mu REAL DEFAULT 0.13,
      distribution_type TEXT DEFAULT 'poisson',
      num_matches INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tournament_name, team_name)
    )
  `)
}

async function calibrate() {
  await ensureTable()
  logger.info('[CALIBRATE] Reading fixtures from Neon...')

  // 1. Get all fixtures with scores from soccer_fixtures
  const fixturesRes = await pool.query(`
    SELECT f.id, f.league_id, f.home_team_id, f.away_team_id,
           f.goals_home, f.goals_away, l.name as league_name
    FROM soccer_fixtures f
    LEFT JOIN soccer_leagues l ON f.league_id = l.id
    WHERE f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
  `)

  const fixtures = fixturesRes.rows
  logger.info(`[CALIBRATE] Loaded ${fixtures.length} fixtures`)

  // 2. Get team names from soccer_teams
  const teamsRes = await pool.query('SELECT id, name FROM soccer_teams')
  const teamName = {}
  for (const t of teamsRes.rows) {
    teamName[t.id] = t.name
  }

  // 3. Group by league and compute per-team attack/defense
  const leagueTeams = {}
  const leagueMatches = {}
  const leagueTotals = {}

  for (const f of fixtures) {
    const league = f.league_name || `league_${f.league_id}`
    if (!leagueTeams[league]) leagueTeams[league] = {}
    if (!leagueMatches[league]) leagueMatches[league] = []
    if (!leagueTotals[league]) leagueTotals[league] = { homeGoals: 0, awayGoals: 0, matches: 0 }

    const homeId = f.home_team_id
    const awayId = f.away_team_id
    const home = teamName[homeId] || `team_${homeId}`
    const away = teamName[awayId] || `team_${awayId}`
    const gh = f.goals_home
    const ga = f.goals_away

    if (!leagueTeams[league][home])
      leagueTeams[league][home] = { goalsFor: 0, goalsAgainst: 0, homeMatches: 0, awayMatches: 0 }
    if (!leagueTeams[league][away])
      leagueTeams[league][away] = { goalsFor: 0, goalsAgainst: 0, homeMatches: 0, awayMatches: 0 }

    leagueTeams[league][home].goalsFor += gh
    leagueTeams[league][home].goalsAgainst += ga
    leagueTeams[league][home].homeMatches++

    leagueTeams[league][away].goalsFor += ga
    leagueTeams[league][away].goalsAgainst += gh
    leagueTeams[league][away].awayMatches++

    leagueMatches[league].push({ home, away, gh, ga })
    leagueTotals[league].homeGoals += gh
    leagueTotals[league].awayGoals += ga
    leagueTotals[league].matches++
  }

  // 4. Compute HFA and rho per league
  const params = []
  for (const [league, teams] of Object.entries(leagueTeams)) {
    const total = leagueTotals[league]
    const avgHomeGoals = total.homeGoals / total.matches
    const avgAwayGoals = total.awayGoals / total.matches
    const hfa = avgHomeGoals - avgAwayGoals
    const avgGoals = (total.homeGoals + total.awayGoals) / total.matches

    // Dixon-Coles rho: correlation of low scores (0-0, 1-0, 0-1)
    let lowScorePairs = 0
    let totalPairs = 0
    for (const m of leagueMatches[league]) {
      if (m.gh <= 1 && m.ga <= 1) lowScorePairs++
      totalPairs++
    }
    const rho = totalPairs > 0 ? lowScorePairs / totalPairs - 0.25 : -0.12

    // 5. Per-team attack/defense ratings
    for (const [team, stats] of Object.entries(teams)) {
      const totalMatches = stats.homeMatches + stats.awayMatches
      if (totalMatches < MIN_MATCHES) continue

      const attackRating = stats.goalsFor / totalMatches / Math.max(avgGoals, 0.5)
      const defenseRating = stats.goalsAgainst / totalMatches / Math.max(avgGoals, 0.5)

      params.push({
        tournament_name: league,
        team_name: team,
        attack_rating: Math.round(attackRating * 100) / 100,
        defense_rating: Math.round(defenseRating * 100) / 100,
        hfa: Math.round(hfa * 100) / 100,
        rho: Math.round(rho * 100) / 100,
        mu: Math.round(avgGoals * 100) / 100,
        distribution_type: 'poisson',
        num_matches: totalMatches,
      })
    }

    // 6. Insert league-level row (team_name = null)
    params.push({
      tournament_name: league,
      team_name: null,
      attack_rating: null,
      defense_rating: null,
      hfa: Math.round(hfa * 100) / 100,
      rho: Math.round(rho * 100) / 100,
      mu: Math.round(avgGoals * 100) / 100,
      distribution_type: total.variance ? 'negbin' : 'poisson',
      num_matches: total.matches,
    })
  }

  logger.info(
    `[CALIBRATE] Computed ${params.length} parameter rows for ${Object.keys(leagueTeams).length} leagues`
  )

  // 7. Bulk upsert into Neon (batches of 500)
  let inserted = 0
  const BATCH = 500
  for (let i = 0; i < params.length; i += BATCH) {
    const batch = params.slice(i, i + BATCH)
    const valueRows = []
    const vals = []
    let idx = 0
    for (const p of batch) {
      valueRows.push(
        `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9}, NOW())`
      )
      vals.push(
        p.tournament_name,
        p.team_name,
        p.attack_rating,
        p.defense_rating,
        p.hfa,
        p.rho,
        p.mu,
        p.distribution_type,
        p.num_matches
      )
      idx += 9
    }
    try {
      const res = await pool.query(
        `
        INSERT INTO league_model_parameters 
          (tournament_name, team_name, attack_rating, defense_rating, hfa, rho, mu, distribution_type, num_matches, updated_at)
        VALUES ${valueRows.join(', ')}
        ON CONFLICT (tournament_name, team_name) 
        DO UPDATE SET 
          attack_rating = EXCLUDED.attack_rating,
          defense_rating = EXCLUDED.defense_rating,
          hfa = EXCLUDED.hfa,
          rho = EXCLUDED.rho,
          mu = EXCLUDED.mu,
          distribution_type = EXCLUDED.distribution_type,
          num_matches = EXCLUDED.num_matches,
          updated_at = NOW()
      `,
        vals
      )
      inserted += batch.length
    } catch (e) {
      logger.warn(`[CALIBRATE] Batch insert error at ${i}: ${e.message}`)
    }
    if (i % 2000 === 0)
      logger.info(`[CALIBRATE] Inserting... ${Math.round((i / params.length) * 100)}%`)
  }

  logger.info(`[CALIBRATE] ✅ Upserted ${inserted} parameter rows`)
  return { leagues: Object.keys(leagueTeams).length, params: inserted }
}

async function close() {
  await pool.end()
}

export = { calibrate, close }

if (require.main === module) {
  calibrate()
    .then((r) => {
      console.log(`Calibration complete: ${r.leagues} leagues, ${r.params} params`)
      return close()
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
