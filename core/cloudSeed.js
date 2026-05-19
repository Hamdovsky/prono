/**
 * cloudSeed.js — Titanium Cloud Bootstrap
 * 
 * Runs at server startup on Render (or any cloud without Puppeteer).
 * Uses direct axios calls to Sofascore's JSON API to seed the DB with
 * today's & tomorrow's matches — no headless browser required.
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');

const database = require('./database');

const BASE = 'https://www.sofascore.com/api/v1';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.sofascore.com',
    'Referer': 'https://www.sofascore.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
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
        console.warn(`⚠️ [CLOUD-SEED] Failed to fetch events for ${date}: ${e.message}`);
        return [];
    }
}

async function fetchOdds(matchId) {
    try {
        const url = `${BASE}/event/${matchId}/odds/1/featured`;
        const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000 });
        return data.featured || null;
    } catch (_) { return null; }
}

function extractBasicMatch(event) {
    const ts = event.startTimestamp || Math.floor(Date.now() / 1000);
    return {
        id: event.id,
        homeTeam: event.homeTeam?.name || 'Home',
        awayTeam: event.awayTeam?.name || 'Away',
        home_team_id: event.homeTeam?.id,
        away_team_id: event.awayTeam?.id,
        league: event.tournament?.name || event.tournament?.uniqueTournament?.name || 'Unknown',
        category_name: event.tournament?.category?.name || '',
        tournament_name: event.tournament?.name || '',
        tournament_id: event.tournament?.uniqueTournament?.id,
        season_id: event.season?.id,
        startTimestamp: ts,
        timestamp: new Date(ts * 1000).toISOString(),
        status: event.status?.type || 'notstarted',
        home_win_probability: null,
        away_win_probability: null,
        draw_probability: null,
        confidence: 50,
        prediction: null,
        verdict: 'PENDING',
    };
}

async function hasMatchesForToday() {
    try {
        const db = database.db;
        if (!db) return false;
        const today = getDateStr(0);
        // Count matches with today's date in startTimestamp
        const todayStart = Math.floor(new Date(today + 'T00:00:00Z').getTime() / 1000);
        const todayEnd = todayStart + 86400;
        const row = db.prepare(
            `SELECT COUNT(*) as cnt FROM matches WHERE startTimestamp >= ? AND startTimestamp < ?`
        ).get(todayStart, todayEnd);
        return (row?.cnt || 0) > 0;
    } catch (_) { return false; }
}

async function upsertMatch(match) {
    try {
        const db = database.db;
        if (!db) return;
        const existing = db.prepare('SELECT id FROM matches WHERE id = ?').get(match.id);
        if (existing) return; // Don't overwrite already-enriched data

        db.prepare(`
            INSERT OR IGNORE INTO matches (
                id, homeTeam, awayTeam, league, category_name, tournament_name,
                tournament_id, season_id, startTimestamp, timestamp, status,
                home_team_id, away_team_id,
                odds_home, odds_draw, odds_away,
                confidence, prediction, verdict,
                last_updated, insufficient_data
            ) VALUES (
                @id, @homeTeam, @awayTeam, @league, @category_name, @tournament_name,
                @tournament_id, @season_id, @startTimestamp, @timestamp, @status,
                @home_team_id, @away_team_id,
                @odds_home, @odds_draw, @odds_away,
                @confidence, @prediction, @verdict,
                @last_updated, 1
            )
        `).run({
            ...match,
            last_updated: Date.now(),
        });
    } catch (e) {
        // Non-fatal — ignore schema mismatches on first boot
    }
}

async function runCloudSeed() {
    console.log('🌱 [CLOUD-SEED] Checking if DB seed is needed...');

    const alreadySeeded = await hasMatchesForToday();
    if (alreadySeeded) {
        console.log('✅ [CLOUD-SEED] DB already has matches for today. Skipping seed.');
        return;
    }

    console.log('🌱 [CLOUD-SEED] DB is empty. Seeding from Sofascore API (no Puppeteer)...');

    const dates = [getDateStr(-1), getDateStr(0), getDateStr(1), getDateStr(2)];
    let total = 0;

    for (const date of dates) {
        const events = await fetchEvents(date);
        console.log(`📅 [CLOUD-SEED] ${date}: ${events.length} events`);

        for (const event of events) {
            if (!event.id || !event.homeTeam || !event.awayTeam) continue;

            const status = (event.status?.type || '').toLowerCase();
            // Skip already finished matches
            if (['finished', 'canceled', 'postponed'].includes(status)) continue;

            const match = extractBasicMatch(event);

            // Try to get basic odds (lightweight call)
            const featured = await fetchOdds(event.id);
            if (featured) {
                const market = featured.default || featured.fullTime || Object.values(featured)[0];
                market?.choices?.forEach(c => {
                    const name = (c.name || '').toLowerCase();
                    const val = parseFloat(c.decimalValue || c.fractionalValue || 0);
                    if (val > 1) {
                        if (name === '1' || name === 'home') match.odds_home = val;
                        else if (name === 'x' || name === 'draw') match.odds_draw = val;
                        else if (name === '2' || name === 'away') match.odds_away = val;
                    }
                });
            }

            await upsertMatch(match);
            total++;

            // Small delay to be polite to the API
            await new Promise(r => setTimeout(r, 300));
        }
    }

    console.log(`✅ [CLOUD-SEED] Seeded ${total} matches into DB. Full enrichment will follow via background cron.`);
}

module.exports = { runCloudSeed };
