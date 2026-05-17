const { fetchMatchStats } = require('./src/StatsFetcher');
const Extractor = require('./src/Extractor');
const { fetch } = require('undici');

const SOFA = 'https://www.sofascore.com/api/v1';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
};

async function testStatsCollection() {
    console.log('🚀 [DIAGNOSTIC] Testing Full Match Stats Collection...');

    try {
        // 1. Get Today's Events
        const d = new Date().toISOString().split('T')[0];
        console.log(`📡 [API] Fetching events for: ${d}`);
        const res = await fetch(`${SOFA}/sport/football/scheduled-events/${d}`, { headers: HEADERS });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const { events = [] } = await res.json();

        // 2. Find a Live or Finished match
        const activeMatch = events.find(e => e.status.type === 'inprogress' || e.status.type === 'finished');

        if (!activeMatch) {
            console.log('⚠️ [WARN] No live or finished matches found for today. Searching for a scheduled one instead.');
            const scheduledMatch = events[0];
            if (!scheduledMatch) {
                console.log('❌ [ERROR] No matches found at all.');
                return;
            }
            await testMatch(scheduledMatch);
        } else {
            await testMatch(activeMatch);
        }

    } catch (e) {
        console.error('❌ [FATAL] Test failed:', e.message);
    }
}

async function testMatch(match) {
    console.log(`⚽ [MATCH] Testing: ${match.homeTeam.name} vs ${match.awayTeam.name} (Status: ${match.status.type})`);
    console.log(`🆔 [ID] ${match.id}`);

    try {
        // 3. Fetch detailed stats using StatsFetcher
        console.log('📡 [STATS] Fetching detailed statistics...');
        const statsData = await fetchMatchStats(match.id, match.slug);

        if (!statsData || !statsData.stats) {
            console.log('❌ [STATS] No detailed statistics found for this match.');
            return;
        }

        // 4. Format using Extractor
        const formatted = Extractor.formatStatistics(statsData.stats);

        console.log(`📊 [SUCCESS] Collected ${formatted.stats.length} statistical categories.`);

        const keyStats = ['Possession', 'Ball possession', 'Total shots', 'Shots on target', 'Corners', 'Corner kicks', 'Dangerous attacks'];
        const foundKeyStats = formatted.stats.filter(s =>
            keyStats.some(k => s.category.toLowerCase().includes(k.toLowerCase()))
        );

        console.log('\n🔍 [KEY STATS CAPTURED]:');
        if (foundKeyStats.length > 0) {
            foundKeyStats.forEach(s => {
                console.log(`   - ${s.category}: ${s.homeValue} / ${s.awayValue}`);
            });
        } else {
            console.log('   ⚠️ None of the standard key stats found (match might not have started or data set is unusual).');
        }

        console.log('\n📄 [FULL STATS DUMP]:');
        console.log(JSON.stringify(formatted.stats, null, 2));

    } catch (e) {
        console.error('❌ [ERROR] Match test failed:', e.message);
    }
}

testStatsCollection();
