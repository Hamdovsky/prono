const Database = require('better-sqlite3');
const db = new Database('data/tactical.db');

const tomorrowMatches = db.prepare(`
    SELECT homeTeam, awayTeam, home_win_probability, away_win_probability, 
           draw_probability, insufficient_data, tournament_name,
           datetime(startTimestamp, 'unixepoch') as date
    FROM matches 
    WHERE date(datetime(startTimestamp, 'unixepoch')) = date('now', '+1 day')
`).all();

console.log(`Found ${tomorrowMatches.length} matches for tomorrow.`);

tomorrowMatches.forEach(m => {
    const domProb = Math.max(m.home_win_probability || 0, m.away_win_probability || 0);
    let msLabel = '⚪';
    if (m.insufficient_data === 1) msLabel = '⚠️ (Data)';
    else if (domProb >= 70) msLabel = '🟢 (High)';
    else if (domProb >= 55) msLabel = '🟡 (Med)';
    else msLabel = '🟠/🔵 (Low/Bal)';

    console.log(`${msLabel} | ${m.homeTeam} vs ${m.awayTeam} | H: ${m.home_win_probability}% | A: ${m.away_win_probability}% | (${m.tournament_name})`);
});

db.close();
