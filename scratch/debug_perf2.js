const db = require('better-sqlite3')('data/tactical.db');
const matches = db.prepare(`SELECT * FROM matches WHERE status IN ('finished', 'ft') LIMIT 30`).all();

let verifiableCount = 0;
let wins = 0;

matches.forEach(m => {
    // API Normalization simulation (dataService.js)
    if (typeof m.fullData === 'string') {
        try { m.enriched = JSON.parse(m.fullData); } catch (e) {}
    }
    m.home_win_probability = m.home_win_probability || (m.enriched && m.enriched.winnerProbability ? m.enriched.winnerProbability * 100 : null);
    
    // PerformanceHub logic
    const h = Number(m.scoreHome);
    const a = Number(m.scoreAway);
    if (isNaN(h) || isNaN(a)) return;
    
    const total = h + a;
    
    const hPct = Number(m.home_win_probability || m.enriched?.winnerProbability || 0);
    const aPct = Number(m.away_win_probability || 0);
    const pBTTS = Number(m.btts_prob || m.enriched?.btts_prob || 0);
    const pOU25 = Number(m.ou_25_prob || m.enriched?.ou_25_prob || 0);

    const markets = [];
    if (pOU25 > 65) markets.push({ prob: pOU25, type: 'OVER25' });
    if (pBTTS > 65) markets.push({ prob: pBTTS, type: 'BTTS' });
    
    if (pOU25 <= 40 && pBTTS <= 40) {
        markets.push({ prob: 100 - pOU25, type: 'UNDER25' });
        markets.push({ prob: 100 - pBTTS, type: 'NO_BTTS' });
    }

    markets.push({ prob: Math.max(hPct, aPct), type: hPct > aPct ? 'HOME' : 'AWAY' });
    
    markets.sort((x, y) => y.prob - x.prob);
    const smartPick = markets[0]?.type || 'UNKNOWN';

    let isWin = false;
    
    if (smartPick === 'HOME') isWin = h > a;
    else if (smartPick === 'AWAY') isWin = a > h;
    else if (smartPick === 'OVER25') isWin = total > 2.5;
    else if (smartPick === 'UNDER25') isWin = total < 2.5;
    else if (smartPick === 'BTTS') isWin = h > 0 && a > 0;
    else if (smartPick === 'NO_BTTS') isWin = h === 0 || a === 0;

    verifiableCount++;
    if (isWin) wins++;

    console.log(`[${h}-${a}] ${m.homeTeam} vs ${m.awayTeam} | Probs: H:${hPct} A:${aPct} O:${pOU25} B:${pBTTS} | Pick: ${smartPick} | Win: ${isWin}`);
});

console.log(`\nVerifiable: ${verifiableCount}, Wins: ${wins}`);
