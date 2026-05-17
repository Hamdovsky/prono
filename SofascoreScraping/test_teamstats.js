/**
 * test_teamstats.js — Vérifie pourquoi les teamStats sont vides
 */
const SOFA = 'https://www.sofascore.com/api/v1';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.sofascore.com/'
};

async function test() {
    // 1. Récupérer les matchs du jour
    const today = new Date().toISOString().split('T')[0];
    console.log('Date:', today);

    const res = await fetch(`${SOFA}/sport/football/scheduled-events/${today}`, { headers: HEADERS });
    const { events = [] } = await res.json();
    console.log('Total events:', events.length);

    // 2. Chercher un match pre-match avec tous les IDs
    const sample = events.find(e =>
        e.status?.type === 'notstarted' &&
        e.homeTeam?.id &&
        e.tournament?.uniqueTournament?.id &&
        e.season?.id
    );

    if (!sample) {
        console.log('Aucun match pre-match trouvé avec IDs complets');
        return;
    }

    const teamId = sample.homeTeam.id;
    const tId = sample.tournament.uniqueTournament.id;
    const sId = sample.season.id;

    console.log('\n--- Match sélectionné ---');
    console.log('Match  :', sample.homeTeam.name, 'vs', sample.awayTeam.name);
    console.log('teamId :', teamId);
    console.log('tournId:', tId);
    console.log('seasonId:', sId);

    // 3. Tester l'endpoint statistics/overall
    const statsUrl = `${SOFA}/team/${teamId}/unique-tournament/${tId}/season/${sId}/statistics/overall`;
    console.log('\nURL testée:', statsUrl);

    const r = await fetch(statsUrl, { headers: HEADERS });
    console.log('HTTP Status:', r.status, r.statusText);

    if (!r.ok) {
        console.log('Erreur HTTP — réponse brute:', await r.text().then(t => t.slice(0, 300)));
        return;
    }

    const data = await r.json();
    console.log('Keys de la réponse:', Object.keys(data));

    const s = data.statistics;
    if (!s) {
        console.log('Pas de champ "statistics" dans la réponse');
        console.log('Réponse complète:', JSON.stringify(data).slice(0, 400));
        return;
    }

    console.log('\n--- Statistics ---');
    console.log('matchesPlayed  :', s.matchesPlayed);
    console.log('goalsScored    :', s.goalsScored);
    console.log('goalsConceded  :', s.goalsConceded);
    console.log('shotsOnTarget  :', s.shotsOnTarget);
    console.log('cornerKicks    :', s.cornerKicks);

    if (!s.matchesPlayed) {
        console.log('\n⚠️  matchesPlayed = 0 ou undefined!');
        console.log('Clés disponibles dans statistics:', Object.keys(s).slice(0, 20));
    } else {
        const mp = s.matchesPlayed;
        console.log('\n--- Moyennes calculées ---');
        console.log('avgGoalsScored   :', (s.goalsScored / mp).toFixed(2));
        console.log('avgGoalsConceded :', (s.goalsConceded / mp).toFixed(2));
        console.log('avgShotsOnTarget :', (s.shotsOnTarget / mp).toFixed(2));
        console.log('avgCorners       :', ((s.cornerKicks || 0) / mp).toFixed(2));
        console.log('\n✅ TeamStats fonctionnels !');
    }

    // 4. Aussi tester avec type=home
    console.log('\n--- Test avec type=home ---');
    const homeUrl = `${SOFA}/team/${teamId}/unique-tournament/${tId}/season/${sId}/statistics/home`;
    const rh = await fetch(homeUrl, { headers: HEADERS });
    console.log('HTTP Status (home):', rh.status);
    if (rh.ok) {
        const dh = await rh.json();
        if (dh.statistics?.matchesPlayed) {
            console.log('matchesPlayed (home):', dh.statistics.matchesPlayed);
            console.log('✅ Home stats OK');
        }
    }
}

test().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
