/**
 * MotivationEnrichService.js — V50
 * Computes the Dynamic Motivation Factor (DMF) fields for each team.
 * Uses league standings to determine a team's position relative to key thresholds
 * (title race, European spots, relegation zone) and injects them into match objects.
 */

const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

// Simple in-memory cache: { `${tournamentId}_${seasonId}`: { timestamp, rows } }
const STANDINGS_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get league standings, cached.
 */
async function getStandings(tournamentId, seasonId) {
    if (!tournamentId || !seasonId) return null;
    const key = `${tournamentId}_${seasonId}`;
    const cached = STANDINGS_CACHE.get(key);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) return cached.rows;

    try {
        const data = await SofaAPI.getStandings(tournamentId, seasonId);
        const rows = data?.standings?.[0]?.rows || [];
        if (rows.length > 0) {
            STANDINGS_CACHE.set(key, { timestamp: Date.now(), rows });
        }
        return rows;
    } catch (e) {
        return null;
    }
}

/**
 * From standings rows, compute the DMF profile for a given team ID.
 * Returns:
 *  - target_weight: 0.0-2.0 (how crucial is the target = relegation/title/europe)
 *  - distance_to_target: points gap to the nearest decisive threshold
 *  - matches_remaining: inferred from max(matches played) - team's matches played
 *  - zone: 'Battle Zone (Title)', 'Battle Zone (Relegation)', 'Dead Zone', 'Momentum Zone'
 */
function computeDMFProfile(rows, teamId) {
    if (!rows || rows.length === 0) return _defaultDMF();

    const totalTeams = rows.length;
    const sorted = [...rows].sort((a, b) => a.position - b.position);
    const teamRow = sorted.find(r => r.team?.id == teamId);
    if (!teamRow) return _defaultDMF();

    const pos = teamRow.position;
    const pts = teamRow.points;
    const maxMatches = Math.max(...rows.map(r => r.matches || 0));
    const teamMatches = teamRow.matches || maxMatches;
    const matchesRemaining = Math.max(0, maxMatches + 4 - teamMatches); // heuristic: assume ~4 more remaining at similar pace

    // Determine RELEGATE zone (bottom 3 by default)
    const relegZoneSize = totalTeams >= 20 ? 3 : (totalTeams >= 16 ? 3 : 2);
    const relegLine = totalTeams - relegZoneSize + 1; // e.g. 18/20

    // Determine EUROPE spots (top 6 by default)
    const euroLine = Math.min(6, Math.ceil(totalTeams * 0.3));

    // Determine TITLE (top 1)
    const leaderPts = sorted[0]?.points || pts;

    // Determine zone & target
    let targetWeight = 0.0;
    let zone = 'Dead Zone';
    let distanceToTarget = 0;

    if (pos <= 2) {
        // Title race
        zone = 'Battle Zone (Title)';
        targetWeight = 1.5;
        const secondPts = sorted[1]?.points || pts;
        distanceToTarget = Math.max(0, leaderPts - (pos === 1 ? secondPts : pts));
    } else if (pos <= euroLine) {
        // European race
        zone = 'Battle Zone (Europe)';
        targetWeight = 1.0;
        const euroEdgePts = sorted[euroLine]?.points || pts;
        distanceToTarget = Math.max(0, pts - euroEdgePts);
    } else if (pos >= relegLine) {
        // Relegation fight
        zone = 'Battle Zone (Relegation)';
        targetWeight = 2.0; // Most critical
        const safeLinePts = sorted[relegLine - 2]?.points || (pts + 1);
        distanceToTarget = Math.max(0, safeLinePts - pts);
    } else {
        // Mid-table / Dead Zone
        zone = 'Dead Zone';
        targetWeight = 0.0;
        distanceToTarget = 0;
    }

    // Detect Momentum Zone (recent form: 3+ wins in a row)
    const recentForm = (teamRow.wins || 0) > 0;  // Simplified; ideally check last 5 results
    if (zone === 'Dead Zone' && recentForm) {
        zone = 'Momentum Zone';
        targetWeight = 0.3; // Slight morale boost
    }

    return {
        target_weight: targetWeight,
        distance_to_target: distanceToTarget,
        matches_remaining: matchesRemaining,
        zone,
        position: pos,
        points: pts,
    };
}

function _defaultDMF() {
    return { target_weight: 0, distance_to_target: 0, matches_remaining: 10, zone: 'Unknown' };
}

/**
 * Main enrichment function.
 * Injects V50 DMF fields into a match object:
 *   home_target_weight, home_distance_target, home_matches_remaining, home_zone
 *   away_target_weight, away_distance_target, away_matches_remaining, away_zone
 */
async function enrichWithMotivation(match) {
    const tId = match._uniqueTournament || match.tournamentId;
    const sId = match._seasonId || match.seasonId;
    const homeId = match._homeTeamId || match.homeTeamId;
    const awayId = match._awayTeamId || match.awayTeamId;

    if (!tId || !sId) return match; // Can't enrich without IDs

    try {
        const rows = await getStandings(tId, sId);
        if (!rows) return match;

        const homeProfile = computeDMFProfile(rows, homeId);
        const awayProfile = computeDMFProfile(rows, awayId);

        match.home_target_weight = homeProfile.target_weight;
        match.home_distance_target = homeProfile.distance_to_target;
        match.home_matches_remaining = homeProfile.matches_remaining;
        match.home_zone = homeProfile.zone;

        match.away_target_weight = awayProfile.target_weight;
        match.away_distance_target = awayProfile.distance_to_target;
        match.away_matches_remaining = awayProfile.matches_remaining;
        match.away_zone = awayProfile.zone;
    } catch (e) {
        // Non-fatal: DMF enrichment fails silently
    }
    return match;
}

module.exports = { enrichWithMotivation, computeDMFProfile, getStandings };
