const db = require('better-sqlite3')('data/tactical.db');
const matches = db.prepare(`SELECT * FROM matches WHERE status IN ('finished', 'ft') LIMIT 26`).all();

let verifiableCount = 0;
let wins = 0;

matches.forEach(m => {
    const h = Number(m.scoreHome);
    const a = Number(m.scoreAway);
    if (isNaN(h) || isNaN(a)) return; 
    
    const total = h + a;
    let pick = String(m.prediction || "").toLowerCase();
    
    // Parse JSON enriched string to get probabilities
    let enriched = null;
    if (typeof m.fullData === 'string') {
        try { enriched = JSON.parse(m.fullData); } catch (e) {}
    }
    
    const hPct = Number(m.home_win_probability || enriched?.winnerProbability || 0);
    const aPct = Number(m.away_win_probability || 0);
    const pBTTS = Number(m.btts_prob || enriched?.btts_prob || 0);
    const pOU25 = Number(m.ou_25_prob || enriched?.ou_25_prob || 0);
    
    let originalPick = pick;
    let usedFallback = false;

    if (!pick || pick === "null" || pick === "undefined") {
        usedFallback = true;
        if (pOU25 > 65) pick = "+2.5";
        else if (pBTTS > 65) pick = "btts";
        else if (pOU25 <= 40 && pBTTS <= 40 && pOU25 > 0) pick = "-2.5";
        else pick = hPct > aPct ? "1" : "2";
    }

    let isWin = false;
    let isVerifiable = true;
    let matchType = "";

    if (pick.includes('البطاقات') || pick.includes('cards') || pick.includes('corner')) {
        isVerifiable = false; 
        matchType = "UNVERIFIABLE_CARD/CORNER";
    }
    else if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) { isWin = h > a; matchType = "1"; }
    else if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) { isWin = a > h; matchType = "2"; }
    else if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) { isWin = h === a; matchType = "X"; }
    else if (pick.includes('+1.5') || pick.includes('over 1.5')) { isWin = total > 1.5; matchType = "+1.5"; }
    else if (pick.includes('-1.5') || pick.includes('under 1.5')) { isWin = total < 1.5; matchType = "-1.5"; }
    else if (pick.includes('+2.5') || pick.includes('over 2.5')) { isWin = total > 2.5; matchType = "+2.5"; }
    else if (pick.includes('-2.5') || pick.includes('under 2.5')) { isWin = total < 2.5; matchType = "-2.5"; }
    else if (pick.includes('+3.5') || pick.includes('over 3.5')) { isWin = total > 3.5; matchType = "+3.5"; }
    else if (pick.includes('-3.5') || pick.includes('under 3.5')) { isWin = total < 3.5; matchType = "-3.5"; }
    else if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) { isWin = h > 0 && a > 0; matchType = "BTTS"; }
    else {
        isVerifiable = false; 
        matchType = "UNKNOWN";
    }

    if (isVerifiable) {
        verifiableCount++;
        if (isWin) wins++;
    }
    
    console.log(`${m.homeTeam} vs ${m.awayTeam} | Pick: "${originalPick}" -> "${pick}" | Verifiable: ${isVerifiable} | Type: ${matchType}`);
});

console.log(`\nVerifiable: ${verifiableCount}, Wins: ${wins}`);
