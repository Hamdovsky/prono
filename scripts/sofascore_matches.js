/**
 * ⚡ SOFASCORE MATCH FETCHER — Titanium V1
 * ─────────────────────────────────────────
 * Récupère les matchs de football du jour/demain
 * depuis l'API SofaScore + les cotes 1X2.
 * Sauvegarde en JSON + SQLite (sofascore_matches.json)
 * pour compatibilité avec le reste du système.
 *
 * Usage:
 *   node scripts/sofascore_matches.js           → matchs du jour
 *   node scripts/sofascore_matches.js --tomorrow → matchs de demain
 *   node scripts/sofascore_matches.js --both     → aujourd'hui + demain
 */

const path = require('path');
const fs   = require('fs');

// ── Bootstrap project root ────────────────────────────────────────────────────
process.chdir(path.resolve(__dirname, '..'));
require('dotenv').config();

const { SofaAPI }  = require('../SofascoreScraping/src/apiClient');
const Database     = require('better-sqlite3');

const OUTPUT_JSON = path.resolve(__dirname, '../data/sofascore_matches.json');
const DB_PATH     = path.resolve(__dirname, '../data/tactical.db');

const TOMORROW = process.argv.includes('--tomorrow');
const BOTH     = process.argv.includes('--both');

function getDateStr(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp * 1000);
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Casablanca' });
}

function parseOdd(v) {
    const n = parseFloat(v);
    return (!isNaN(n) && n > 1.0) ? +n.toFixed(2) : null;
}

// ── Save to SQLite ─────────────────────────────────────────────────────────────
function saveToDb(matches) {
    try {
        const db = new Database(DB_PATH);
        db.exec(`
            CREATE TABLE IF NOT EXISTS sofascore_matches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                home_team TEXT, away_team TEXT, time TEXT, league TEXT,
                odds_1 REAL, odds_x REAL, odds_2 REAL, source TEXT, scraped_at INTEGER
            )
        `);
        const now = Math.floor(Date.now() / 1000);
        db.exec(`DELETE FROM sofascore_matches WHERE scraped_at >= ${now - 86400}`);
        const ins = db.prepare(
            `INSERT INTO sofascore_matches (home_team,away_team,time,league,odds_1,odds_x,odds_2,source,scraped_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
        );
        db.transaction(rows => rows.forEach(m =>
            ins.run(m.home_team, m.away_team, m.time, m.league,
                m.odds_1, m.odds_x, m.odds_2, m.source, now)
        ))(matches);
        db.close();
        console.log(`   DB: ${matches.length} matchs sauvegardés`);
    } catch(e) { console.warn(`   DB warning: ${e.message}`); }
}

// ── Extract odds for a match ──────────────────────────────────────────────────
async function getOdds(matchId) {
    try {
        const data = await SofaAPI.getOddsFeatured(matchId);
        if (!data) return { o1: null, oX: null, o2: null };

        // SofaScore returns { featured: [ { marketName, choices: [{name, fractionalValue, sourceOdds}] } ] }
        const markets = data.featured || data.markets || [];
        
        const market1X2 = markets.find(m =>
            /full.?time.?result|1x2|match.?winner|winner/i.test(m.marketName || m.title || '')
        ) || markets[0];

        if (!market1X2) return { o1: null, oX: null, o2: null };

        const choices = market1X2.choices || market1X2.outcomes || [];
        
        // sourceOdds is the decimal odd value
        const findOdd = (names) => {
            const c = choices.find(ch => names.includes((ch.name || '').toUpperCase()));
            const val = c?.sourceOdds ?? c?.fractionalValue ?? c?.odds;
            return parseOdd(val);
        };

        return {
            o1: findOdd(['1', 'HOME', 'W1']),
            oX: findOdd(['X', 'DRAW', 'DRAWODDS', 'D']),
            o2: findOdd(['2', 'AWAY', 'W2']),
        };
    } catch(_) {
        return { o1: null, oX: null, o2: null };
    }
}

// ── Fetch matches for a date ──────────────────────────────────────────────────
async function fetchMatchesForDate(dateStr) {
    console.log(`\n📅 Chargement des matchs du ${dateStr}...`);
    
    const data = await SofaAPI.getEvents(dateStr);
    const events = data?.events || [];
    
    console.log(`   ${events.length} matchs trouvés sur SofaScore`);
    
    const matches = [];
    let processed = 0;

    for (const ev of events) {
        try {
            const home   = ev.homeTeam?.name || ev.homeTeam?.shortName || '';
            const away   = ev.awayTeam?.name || ev.awayTeam?.shortName || '';
            const league = ev.tournament?.name || ev.tournament?.uniqueTournament?.name || 'Football';
            const time   = formatTime(ev.startTimestamp);
            const matchId = ev.id;

            if (!home || !away) continue;

            // Get odds (with rate limit — fetch only if match is scheduled)
            let o1 = null, oX = null, o2 = null;
            if (ev.status?.type === 'notstarted' || ev.status?.type === 'scheduled') {
                const odds = await getOdds(matchId);
                o1 = odds.o1; oX = odds.oX; o2 = odds.o2;
            }

            matches.push({
                sofascore_id: matchId,
                home_team:    home.toUpperCase(),
                away_team:    away.toUpperCase(),
                time,
                date:         dateStr,
                league,
                country:      ev.tournament?.category?.name || '',
                status:       ev.status?.type || 'unknown',
                odds_1:       o1,
                odds_x:       oX,
                odds_2:       o2,
                source:       'SofaScore'
            });

            processed++;
            if (processed % 20 === 0) {
                process.stdout.write(`\r   Traité: ${processed}/${events.length}...`);
            }
        } catch(_) {}
    }

    console.log(`\r   ✅ ${matches.length} matchs avec données complètes\n`);
    return matches;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log('\n' + '═'.repeat(58));
    console.log('⚡ SOFASCORE MATCH FETCHER — Titanium V1');
    console.log('═'.repeat(58) + '\n');

    const dates = [];
    if (!TOMORROW || BOTH) dates.push(getDateStr(0)); // today
    if (TOMORROW  || BOTH) dates.push(getDateStr(1)); // tomorrow

    let allMatches = [];
    for (const d of dates) {
        const matches = await fetchMatchesForDate(d);
        allMatches = allMatches.concat(matches);
    }

    // Summary
    const withOdds    = allMatches.filter(m => m.odds_1 || m.odds_2);
    const withoutOdds = allMatches.filter(m => !m.odds_1 && !m.odds_2);

    console.log('═'.repeat(58));
    console.log(`TOTAL     : ${allMatches.length} matchs`);
    console.log(`Avec cotes: ${withOdds.length} matchs`);
    console.log(`Sans cotes: ${withoutOdds.length} matchs`);
    console.log('═'.repeat(58));

    // Preview
    if (allMatches.length > 0) {
        console.log('\n🔍 Aperçu (5 premiers):');
        allMatches.slice(0, 5).forEach((m, i) => {
            console.log(`  ${i+1}. [${m.time}] ${m.home_team} vs ${m.away_team}`);
            console.log(`      ${m.league} | 1:${m.odds_1||'?'} X:${m.odds_x||'?'} 2:${m.odds_2||'?'}`);
        });
    }

    // Save
    fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(allMatches, null, 2));
    console.log(`\n💾 JSON → ${OUTPUT_JSON}`);
    saveToDb(allMatches);

    console.log('\n🚀 Lance ensuite: node scripts/top_elite_selection.js');
    console.log('═'.repeat(58) + '\n');
    
    process.exit(0);
}

main().catch(e => {
    console.error('\n💥 Erreur fatale:', e.message);
    process.exit(1);
});
