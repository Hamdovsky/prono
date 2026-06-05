/**
 * test_cloud_seed.js — Live test of the new dual-source CloudSeed v4
 * 
 * Tests:
 *  1. RapidAPI SportAPI connectivity
 *  2. FootballData.io connectivity (/fixtures/today + /fixtures/upcoming)
 *  3. Full cloudSeed run (with real DB inserts)
 *  4. Post-seed DB count
 */

require('dotenv').config();
const axios = require('axios');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'sportapi7.p.rapidapi.com';
const FD_KEY        = process.env.FOOTBALLDATA_KEY;

function today() {
    return new Date().toISOString().split('T')[0];
}
function tomorrow() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
}

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

async function testRapidApi() {
    console.log('\n═══ TEST 1: RapidAPI SportAPI ═══');
    if (!RAPIDAPI_KEY) { fail('RAPIDAPI_KEY not set in .env'); return 0; }
    if (process.env.RAPIDAPI_ENABLED !== 'true') { fail('RAPIDAPI_ENABLED is not true'); return 0; }

    try {
        const url = `https://${RAPIDAPI_HOST}/api/v1/sport/football/scheduled-events/${today()}`;
        info(`GET ${url}`);
        const { data } = await axios.get(url, {
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY,
                'Accept': 'application/json'
            },
            timeout: 20000
        });
        const events = data.events || [];
        pass(`RapidAPI today: ${events.length} events`);
        if (events.length > 0) {
            const sample = events[0];
            info(`  Sample: ${sample.homeTeam?.name} vs ${sample.awayTeam?.name} (${sample.tournament?.name})`);
        }

        // Tomorrow
        const url2 = `https://${RAPIDAPI_HOST}/api/v1/sport/football/scheduled-events/${tomorrow()}`;
        info(`GET ${url2}`);
        const { data: data2 } = await axios.get(url2, {
            headers: {
                'x-rapidapi-host': RAPIDAPI_HOST,
                'x-rapidapi-key': RAPIDAPI_KEY,
                'Accept': 'application/json'
            },
            timeout: 20000
        });
        const events2 = data2.events || [];
        pass(`RapidAPI tomorrow: ${events2.length} events`);
        return events.length + events2.length;
    } catch (e) {
        const status = e.response?.status;
        fail(`RapidAPI error: HTTP ${status || '?'} — ${e.message}`);
        if (status === 403 || status === 429) {
            info('Quota may be exhausted for today. Will fallback to FootballData.');
        }
        return 0;
    }
}

async function testFootballData() {
    console.log('\n═══ TEST 2: FootballData.io ═══');
    if (!FD_KEY) { fail('FOOTBALLDATA_KEY not set in .env'); return 0; }
    if (process.env.FOOTBALLDATA_ENABLED !== 'true') { fail('FOOTBALLDATA_ENABLED is not true'); return 0; }

    const base = 'https://footballdata.io/api/v1';
    let total = 0;

    for (const endpoint of ['/fixtures/today', '/fixtures/upcoming']) {
        try {
            info(`GET ${base}${endpoint}`);
            const { data } = await axios.get(`${base}${endpoint}`, {
                headers: {
                    'Authorization': `Bearer ${FD_KEY}`,
                    'Accept': 'application/json'
                },
                timeout: 15000
            });
            const root = data?.data || data;
            const fixtures = root?.fixtures || root?.matches || [];
            pass(`${endpoint}: ${fixtures.length} fixtures`);
            if (fixtures.length > 0) {
                const s = fixtures[0];
                const home = s.home_team?.team_name || s.homeTeam || '?';
                const away = s.away_team?.team_name || s.awayTeam || '?';
                const league = s.league?.competition_name || s.league?.name || '?';
                info(`  Sample: ${home} vs ${away} — ${league}`);
            }
            total += fixtures.length;
        } catch (e) {
            fail(`${endpoint} error: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    return total;
}

async function testQuotaManager() {
    console.log('\n═══ TEST 3: Quota Manager ═══');
    try {
        const qm = require('../services/rapidApiQuotaManager');
        const status = qm.getQuotaStatus();
        pass(`Quota manager loaded`);
        info(`  Date: ${status.date}`);
        info(`  Used: ${status.used}/${status.limit}`);
        info(`  Remaining: ${status.remaining}`);
        info(`  Active: ${status.isActive}`);
        return status;
    } catch (e) {
        fail(`Quota manager error: ${e.message}`);
        return null;
    }
}

async function runFullSeed() {
    console.log('\n═══ TEST 4: Full CloudSeed Run ═══');
    try {
        const database = require('../core/database');
        const { runCloudSeed } = require('../core/cloudSeed');

        // Count before
        const db = database.db;
        const before = db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE status = 'scheduled'").get();
        info(`Before seed: ${before.cnt} scheduled matches`);

        await runCloudSeed();

        // Count after
        const after = db.prepare("SELECT COUNT(*) as cnt FROM matches WHERE status = 'scheduled'").get();
        info(`After seed:  ${after.cnt} scheduled matches`);

        const diff = after.cnt - before.cnt;
        if (diff > 0) {
            pass(`Inserted ${diff} new scheduled matches!`);
        } else {
            info('No new matches inserted (may already exist from previous seed)');
        }

        // Show some matches
        const matches = db.prepare(
            "SELECT id, homeTeam, awayTeam, league, timestamp FROM matches WHERE status = 'scheduled' ORDER BY startTimestamp ASC LIMIT 10"
        ).all();
        
        if (matches.length > 0) {
            console.log('\n  📋 Sample scheduled matches:');
            for (const m of matches) {
                const dt = new Date(m.timestamp).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
                console.log(`     [${m.id.substring(0, 8)}] ${m.homeTeam} vs ${m.awayTeam} — ${m.league} @ ${dt}`);
            }
        }

        return after.cnt;
    } catch (e) {
        fail(`Full seed error: ${e.message}`);
        console.error(e.stack);
        return 0;
    }
}

async function main() {
    console.log('🧪 CloudSeed v4 — Live API Test');
    console.log(`📅 Today: ${today()} | Tomorrow: ${tomorrow()}`);
    console.log('─'.repeat(60));

    const rapidCount = await testRapidApi();
    const fdCount    = await testFootballData();
    const quota      = await testQuotaManager();
    const totalInDB  = await runFullSeed();

    console.log('\n═══ SUMMARY ═══');
    console.log(`  RapidAPI events found: ${rapidCount}`);
    console.log(`  FootballData fixtures: ${fdCount}`);
    console.log(`  Quota remaining:       ${quota?.remaining ?? 'N/A'}`);
    console.log(`  Scheduled in DB:       ${totalInDB}`);
    console.log('─'.repeat(60));

    if (totalInDB > 0) {
        console.log('🏆 SUCCESS — Dashboard should now show matches!');
    } else {
        console.log('⚠️  WARNING — No scheduled matches in DB. Check API keys.');
    }
}

main().catch(e => {
    console.error('💥 FATAL:', e.message);
    process.exit(1);
});
