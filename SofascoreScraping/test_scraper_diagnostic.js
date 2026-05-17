/**
 * test_scraper_diagnostic.js
 * ─────────────────────────────────────────────────────
 * Diagnostic complet du scraper Sofascore :
 *  1. Vérifie la connexion API
 *  2. Récupère les matchs du jour
 *  3. Vérifie les teamStats d'un match
 *  4. Vérifie la sauvegarde en DB
 * ─────────────────────────────────────────────────────
 */

const path = require('path');
const Database = require('better-sqlite3');

const SOFA = 'https://www.sofascore.com/api/v1';
const DB_PATH = path.resolve(__dirname, '../data/tactical.db');

// ── Colours for terminal ────────────────────────────────
const G = '\x1b[32m'; const R = '\x1b[31m'; const Y = '\x1b[33m';
const B = '\x1b[34m'; const W = '\x1b[0m';
const ok = `${G}✅${W}`, ko = `${R}❌${W}`, warn = `${Y}⚠️ ${W}`;

function sep(title) {
    console.log(`\n${B}${'─'.repeat(55)}${W}`);
    if (title) console.log(`${B}  ${title}${W}`);
}

async function run() {
    sep('DIAGNOSTIC SCRAPER SOFASCORE');

    // ── 1. TEST API CONNEXION ────────────────────────────
    sep('1. Connexion API Sofascore');
    const today = new Date().toISOString().split('T')[0];
    console.log(`  📅 Date ciblée : ${today}`);

    let events = [];
    try {
        const res = await fetch(`${SOFA}/sport/football/scheduled-events/${today}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!res.ok) {
            console.log(`${ko} HTTP Error: ${res.status} ${res.statusText}`);
            process.exit(1);
        }
        const data = await res.json();
        events = data.events || [];
        console.log(`${ok} API Sofascore accessible`);
        console.log(`  📊 Matchs total récupérés : ${events.length}`);
    } catch (e) {
        console.log(`${ko} API inaccessible : ${e.message}`);
        process.exit(1);
    }

    // ── 2. PARSING DES MATCHS ────────────────────────────
    sep('2. Parsing des matchs');

    const parsed = events.map(e => {
        const home = e.homeTeam?.name;
        const away = e.awayTeam?.name;
        const league = e.tournament?.uniqueTournament?.name || e.tournament?.name || 'Unknown';
        const country = e.tournament?.category?.name || '';
        const status = e.status?.type || 'notstarted';
        const userCount = e.tournament?.uniqueTournament?.userCount || 0;
        let startTime = '';
        if (e.startTimestamp) {
            const d = new Date(e.startTimestamp * 1000);
            startTime = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
        }
        return {
            id: e.id,
            home, away, league, country, status, startTime, userCount,
            homeTeamId: e.homeTeam?.id,
            awayTeamId: e.awayTeam?.id,
            tournamentId: e.tournament?.uniqueTournament?.id,
            seasonId: e.season?.id,
        };
    }).filter(e => e.home && e.away);

    const preMatch = parsed.filter(e => e.status === 'notstarted' || e.status === 'scheduled');
    const live = parsed.filter(e => e.status === 'inprogress');
    const finished = parsed.filter(e => e.status === 'finished');

    console.log(`${ok} Total matchs parsés : ${parsed.length}`);
    console.log(`  ⏳ PRE_MATCH : ${preMatch.length}`);
    console.log(`  🔴 LIVE     : ${live.length}`);
    console.log(`  🏁 FINISHED : ${finished.length}`);

    if (parsed.length === 0) {
        console.log(`${warn} Aucun match parsé. Vérifier le format de la réponse API.`);
        process.exit(1);
    }

    // ── 3. TEST TEAM STATS SUR 3 MATCHS ─────────────────
    sep('3. Fetch TeamStats (3 matchs PRE_MATCH)');

    const samples = preMatch.slice(0, 3);
    if (samples.length === 0) {
        console.log(`${warn} Pas de matchs PRE_MATCH disponibles aujourd'hui — test TeamStats ignoré`);
    }

    for (const match of samples) {
        console.log(`\n  ⚽ ${match.home} vs ${match.away} [${match.league}] — ${match.startTime}`);

        if (!match.homeTeamId || !match.tournamentId || !match.seasonId) {
            console.log(`  ${warn} IDs manquants (homeTeamId=${match.homeTeamId}, tournamentId=${match.tournamentId}, seasonId=${match.seasonId})`);
            continue;
        }

        try {
            const url = `${SOFA}/team/${match.homeTeamId}/unique-tournament/${match.tournamentId}/season/${match.seasonId}/statistics/overall`;
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
            });

            if (!res.ok) {
                console.log(`  ${warn} TeamStats HTTP ${res.status} — pas de stats saison disponibles`);
                continue;
            }

            const { statistics: s } = await res.json();
            if (!s || !s.matchesPlayed) {
                console.log(`  ${warn} Stats saison vides`);
                continue;
            }

            const mp = s.matchesPlayed;
            const avgG = (s.goalsScored / mp).toFixed(2);
            const avgGC = (s.goalsConceded / mp).toFixed(2);
            const avgSoT = (s.shotsOnTarget / mp).toFixed(2);
            const avgC = ((s.cornerKicks || 0) / mp).toFixed(2);

            console.log(`  ${ok} ${match.home} stats saison (${mp} matchs):`);
            console.log(`       Buts marqués/match  : ${avgG}`);
            console.log(`       Buts encaissés/match : ${avgGC}`);
            console.log(`       SoT/match            : ${avgSoT}`);
            console.log(`       Corners/match        : ${avgC}`);
        } catch (e) {
            console.log(`  ${ko} Erreur TeamStats : ${e.message}`);
        }
    }

    // ── 4. VÉRIFICATION BASE DE DONNÉES ──────────────────
    sep('4. État de la base de données');

    try {
        const db = new Database(DB_PATH, { readonly: true });
        const total = db.prepare("SELECT COUNT(*) as c FROM matches").get().c;
        const sched = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('PRE_MATCH','scheduled','notstarted')").get().c;
        const liveDb = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'live'").get().c;
        const lastRow = db.prepare("SELECT homeTeam, awayTeam, league, status, last_updated FROM matches ORDER BY last_updated DESC LIMIT 1").get();

        console.log(`${ok} DB accessible : ${DB_PATH}`);
        console.log(`  Total matchs en DB   : ${total}`);
        console.log(`  PRE_MATCH en DB      : ${sched}`);
        console.log(`  LIVE en DB           : ${liveDb}`);

        if (lastRow) {
            const lastUpdate = new Date(lastRow.last_updated).toLocaleString('fr-FR');
            console.log(`  Dernier match inséré : ${lastRow.homeTeam} vs ${lastRow.awayTeam}`);
            console.log(`  Ligue                : ${lastRow.league}`);
            console.log(`  Status               : ${lastRow.status}`);
            console.log(`  Last updated         : ${lastUpdate}`);
        } else {
            console.log(`  ${warn} Aucun match en base de données`);
        }

        // Check si teamStats sont présents dans fullData
        const withStats = db.prepare(`
            SELECT COUNT(*) as c FROM matches 
            WHERE json_extract(fullData, '$.teamStats.home') IS NOT NULL
        `).get().c;
        console.log(`  Matchs avec teamStats : ${withStats}`);
        db.close();
    } catch (e) {
        console.log(`${ko} Erreur DB : ${e.message}`);
    }

    // ── 5. RÉSUMÉ FINAL ──────────────────────────────────
    sep('5. RÉSUMÉ');
    console.log(`  📡 API Sofascore       : ${ok}`);
    console.log(`  📊 Matchs disponibles  : ${parsed.length} (${preMatch.length} PRE_MATCH)`);
    console.log(`  🏟️  Ligues détectées    : ${[...new Set(parsed.map(e => e.country || e.league))].slice(0, 5).join(', ')}...`);
    console.log(`\n  ${ok} Diagnostic terminé\n`);
}

run().catch(e => {
    console.error(`\n${R}FATAL:${W}`, e.message);
    process.exit(1);
});
