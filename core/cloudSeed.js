/**
 * cloudSeed.js — Titanium Cloud Bootstrap
 *
 * Runs at server startup on Render (or any cloud without Puppeteer).
 * Uses direct axios calls to Sofascore's JSON API to seed the DB with
 * today's & tomorrow's matches — no headless browser required.
 *
 * FIX: status is normalized to 'scheduled' so getMatchesByStatuses() finds them.
 */

const axios = require('axios');
const path = require('path');

// Use the raw db handle exposed by database.js
const database = require('./database');

const BASE = 'https://www.sofascore.com/api/v1';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.sofascore.com',
    'Referer': 'https://www.sofascore.com/',
    'x-requested-with': 'XMLHttpRequest',
};

function getDateStr(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
}

async function fetchEvents(date) {
    try {
        const url = `${BASE}/sport/football/scheduled-events/${date}`;
        const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
        return data.events || [];
    } catch (e) {
        console.warn(`⚠️ [CLOUD-SEED] Failed to fetch ${date}: ${e.message}`);
        return [];
    }
}

async function fetchOdds(matchId) {
    try {
        const { data } = await axios.get(`${BASE}/event/${matchId}/odds/1/featured`, {
            headers: HEADERS, timeout: 8000
        });
        return data.featured || null;
    } catch (_) { return null; }
}

function parseOdds(featured) {
    const result = {};
    if (!featured) return result;
    const market = featured.default || featured.fullTime || Object.values(featured)[0];
    market?.choices?.forEach(c => {
        const name = (c.name || '').toLowerCase();
        const val = parseFloat(c.decimalValue || 0);
        if (val > 1) {
            if (name === '1' || name === 'home') result.odds_home = val;
            else if (name === 'x' || name === 'draw') result.odds_draw = val;
            else if (name === '2' || name === 'away') result.odds_away = val;
        }
    });
    return result;
}

function hasMatchesForToday() {
    try {
        const db = database.db;
        const today = getDateStr(0);
        const todayStart = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000);
        const todayEnd = todayStart + 86400;
        const row = db.prepare(
            `SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp < ?`
        ).get(todayStart, todayEnd);
        return (row?.cnt || 0) > 0;
    } catch (e) {
        console.warn('[CLOUD-SEED] hasMatchesForToday error:', e.message);
        return false;
    }
}

function upsertMatch(event, odds) {
    try {
        const db = database.db;
        const ts = event.startTimestamp || Math.floor(Date.now() / 1000);
        const timestamp = new Date(ts * 1000).toISOString();

        // ✅ KEY FIX: use 'scheduled' — matches what getMatchesByStatuses() queries for
        const rawStatus = (event.status?.type || '').toLowerCase();
        const status = ['finished', 'canceled', 'postponed', 'inprogress'].includes(rawStatus)
            ? rawStatus
            : 'scheduled';

        if (status !== 'scheduled') return; // skip already-played or live

        const match = {
            id: String(event.id),
            homeTeam: event.homeTeam?.name || 'Home',
            awayTeam: event.awayTeam?.name || 'Away',
            league: event.tournament?.name || 'Unknown',
            category_name: event.tournament?.category?.name || '',
            tournament_name: event.tournament?.name || '',
            tournament_id: event.tournament?.uniqueTournament?.id || null,
            season_id: event.season?.id || null,
            home_team_id: event.homeTeam?.id || null,
            away_team_id: event.awayTeam?.id || null,
            startTimestamp: ts,
            timestamp,
            status,
            confidence: 50,
            prediction: null,
            verdict: 'PENDING',
            odds_home: odds.odds_home || null,
            odds_draw: odds.odds_draw || null,
            odds_away: odds.odds_away || null,
            last_updated: Date.now(),
            insufficient_data: 1,
            fullData: JSON.stringify({
                id: event.id,
                homeTeam: event.homeTeam?.name,
                awayTeam: event.awayTeam?.name,
                league: event.tournament?.name,
                startTimestamp: ts,
                timestamp,
                status,
            })
        };

        // Only insert if not already present
        const existing = db.prepare('SELECT id FROM matches WHERE id = ?').get(match.id);
        if (existing) return;

        db.prepare(`
            INSERT OR IGNORE INTO matches (
                id, homeTeam, awayTeam, league, category_name, tournament_name,
                tournament_id, season_id, home_team_id, away_team_id,
                startTimestamp, timestamp, status,
                confidence, prediction, verdict,
                odds_home, odds_draw, odds_away,
                last_updated, insufficient_data, fullData
            ) VALUES (
                @id, @homeTeam, @awayTeam, @league, @category_name, @tournament_name,
                @tournament_id, @season_id, @home_team_id, @away_team_id,
                @startTimestamp, @timestamp, @status,
                @confidence, @prediction, @verdict,
                @odds_home, @odds_draw, @odds_away,
                @last_updated, @insufficient_data, @fullData
            )
        `).run(match);
    } catch (e) {
        console.warn(`[CLOUD-SEED] upsertMatch error for ${event.id}:`, e.message);
    }
}

async function runCloudSeed() {
    console.log('🌱 [CLOUD-SEED] Checking DB...');

    if (hasMatchesForToday()) {
        console.log('✅ [CLOUD-SEED] DB already has matches for today. Skipping.');
        return;
    }

    console.log('🌱 [CLOUD-SEED] DB is empty — seeding from Sofascore API (no Puppeteer)...');

    const dates = [getDateStr(-1), getDateStr(0), getDateStr(1), getDateStr(2)];
    let total = 0;

    for (const date of dates) {
        const events = await fetchEvents(date);
        console.log(`📅 [CLOUD-SEED] ${date}: ${events.length} events received`);

        for (const event of events) {
            if (!event.id || !event.homeTeam || !event.awayTeam) continue;

            // Fetch odds (fast, non-blocking if fails)
            const featured = await fetchOdds(event.id).catch(() => null);
            const odds = parseOdds(featured);

            upsertMatch(event, odds);
            total++;

            // Polite delay
            await new Promise(r => setTimeout(r, 250));
        }
    }

    console.log(`✅ [CLOUD-SEED] Inserted ${total} matches. Dashboard should now show data.`);
}

module.exports = { runCloudSeed };
