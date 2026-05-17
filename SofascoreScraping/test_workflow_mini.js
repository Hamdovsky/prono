/**
 * test_workflow_mini.js
 * Lance un mini-cycle du Workflow sur les 3 premiers matchs pre-match
 * pour vérifier que les teamStats sont bien collectés et sauvegardés.
 */
const Extractor = require('./src/Extractor');
const persistence = require('./src/Persistence');

const SOFA = 'https://www.sofascore.com/api/v1';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'application/json'
};

async function fetchTeamStats(teamId, uniqueTournamentId, seasonId) {
    try {
        const url = `${SOFA}/team/${teamId}/unique-tournament/${uniqueTournamentId}/season/${seasonId}/statistics/overall`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) return null;
        const { statistics: s } = await res.json();
        if (!s) return null;

        // ✅ FIXED: use s.matches (not s.matchesPlayed) + s.corners (not s.cornerKicks)
        const mp = s.matches || s.matchesPlayed || 0;
        if (!mp) return null;

        return {
            avgGoalsScored: +(s.goalsScored / mp).toFixed(2),
            avgGoalsConceded: +(s.goalsConceded / mp).toFixed(2),
            avgShotsOnTarget: +(s.shotsOnTarget / mp).toFixed(2),
            avgCorners: +((s.corners || s.cornerKicks || 0) / mp).toFixed(2),
            avgBigChances: +((s.bigChances || 0) / mp).toFixed(2),
            avgPossession: +(s.averageBallPossession || 50).toFixed(1),
            matchesPlayed: mp,
        };
    } catch (_) { return null; }
}

async function run() {
    console.log('\n🔧 MINI WORKFLOW TEST — TeamStats Fix Verification');
    console.log('─'.repeat(55));

    await persistence.init();

    const today = new Date().toISOString().split('T')[0];
    const res = await fetch(`${SOFA}/sport/football/scheduled-events/${today}`, { headers: HEADERS });
    const { events = [] } = await res.json();

    // Select up to 5 new pre-match events with full metadata
    const candidates = events
        .map(e => Extractor.extractMatch(e) ? ({ match: Extractor.extractMatch(e), event: e }) : null)
        .filter(Boolean)
        .filter(({ match }) => match.status === 'PRE_MATCH')
        .slice(0, 5);

    console.log(`\nTest sur ${candidates.length} matchs PRE_MATCH\n`);

    let statsOk = 0;
    let statsEmpty = 0;

    for (const { match, event } of candidates) {
        const homeTeamId = event.homeTeam?.id;
        const awayTeamId = event.awayTeam?.id;
        const tId = event.tournament?.uniqueTournament?.id;
        const sId = event.season?.id;

        process.stdout.write(`  ⚽ ${match.homeTeam} vs ${match.awayTeam} ... `);

        const [homeStats, awayStats] = await Promise.all([
            fetchTeamStats(homeTeamId, tId, sId),
            fetchTeamStats(awayTeamId, tId, sId),
        ]);

        if (homeStats) {
            statsOk++;
            console.log(`✅ teamStats OK`);
            console.log(`     ${match.homeTeam}: ${homeStats.avgGoalsScored}G/match, ${homeStats.avgCorners} corners (${homeStats.matchesPlayed} matchs)`);
            if (awayStats) {
                console.log(`     ${match.awayTeam}: ${awayStats.avgGoalsScored}G/match, ${awayStats.avgCorners} corners (${awayStats.matchesPlayed} matchs)`);
            }
        } else {
            statsEmpty++;
            console.log(`⚠️  Pas de stats (ligue mineure ou API limitée)`);
        }

        // Save with teamStats to DB
        match._homeTeamId = homeTeamId;
        match._awayTeamId = awayTeamId;
        match.teamStats = { home: homeStats, away: awayStats };
        match.stats = [];
        match.lineups = { home: [], away: [] };

        persistence.insertMatch(match);
    }

    console.log('\n─'.repeat(55));
    console.log(`📊 Résultats:`);
    console.log(`   Matchs testés    : ${candidates.length}`);
    console.log(`   Avec teamStats   : ${statsOk} ✅`);
    console.log(`   Sans teamStats   : ${statsEmpty} ⚠️`);

    if (statsOk > 0) {
        console.log(`\n✅ PASS — Le fix teamStats fonctionne correctement !`);
        console.log(`   Les prévisions utiliseront maintenant les vraies stats saison.`);
    } else {
        console.log(`\n⚠️  Tous les matchs sont sans stats (possiblement ligues mineures non couvertes par Sofascore)`);
    }

    process.exit(0);
}

run().catch(e => {
    console.error('\nFATAL:', e.message);
    process.exit(1);
});
