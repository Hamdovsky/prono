const db = require('better-sqlite3')('data/tactical.db');

// Get matches from yesterday
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const yyyy = yesterday.getFullYear();
const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
const dd = String(yesterday.getDate()).padStart(2, '0');
const dateStr = `${yyyy}-${mm}-${dd}`;

console.log(`Checking matches for: ${dateStr}`);

// We will query matches where startTimestamp is within yesterday
const startMs = new Date(`${dateStr}T00:00:00Z`).getTime() / 1000;
const endMs = new Date(`${dateStr}T23:59:59Z`).getTime() / 1000;

const matches = db.prepare(`
    SELECT * FROM matches 
    WHERE status IN ('finished', 'ft') 
    AND startTimestamp >= ? AND startTimestamp <= ?
`).all(startMs, endMs);

console.log(`Found ${matches.length} finished matches in the database for yesterday.`);

let verifiableCount = 0;
let wins = 0;
let totalProfit = 0;

matches.forEach(m => {
    // Mimic the UI's PerformanceHub logic
    const hRaw = m.scoreHome;
    const aRaw = m.scoreAway;
    
    if (hRaw === null || hRaw === undefined || aRaw === null || aRaw === undefined) return;
    
    const h = Number(hRaw);
    const a = Number(aRaw);
    if (isNaN(h) || isNaN(a)) return;
    
    const total = h + a;
    
    let pick = String(m.prediction || "").toLowerCase();
    let isVerifiable = true;
    let isWin = false;

    if (
        pick.includes('risky bet') || 
        pick.includes('skip') || 
        pick.includes('no bet') || 
        pick.includes('البطاقات') || 
        pick.includes('cards') || 
        pick.includes('corner') ||
        pick === 'null' ||
        pick === 'undefined' ||
        pick === ''
    ) {
        const extractProb = (val) => {
            if (!val) return 0;
            if (typeof val === 'number') return val;
            const parsed = parseFloat(String(val).replace('%', ''));
            return isNaN(parsed) ? 0 : parsed;
        };

        let enriched = m.enriched;
        if (typeof enriched === 'string') {
            try { enriched = JSON.parse(enriched); } catch (e) { enriched = {}; }
        }

        const hPct = extractProb(m.home_win_probability || enriched?.winnerProbability || 0);
        const aPct = extractProb(m.away_win_probability || 0);
        const pBTTS = extractProb(m.btts_prob || enriched?.btts_prob || 0);
        const pOU25 = extractProb(m.ou_25_prob || enriched?.ou_25_prob || 0);

        if (pOU25 > 65) { pick = 'over25'; }
        else if (pBTTS > 65) { pick = 'btts'; }
        else if (hPct > aPct && hPct > 50) { pick = 'home'; }
        else if (aPct > hPct && aPct > 50) { pick = 'away'; }
        else if (pOU25 <= 40 && pBTTS <= 40) { pick = 'under25'; }
        else {
            isVerifiable = false;
        }
    }

    if (isVerifiable) {
        if (pick.includes('home') || pick.includes('dom') || pick === '1' || pick.includes(' 1 ')) isWin = h > a;
        else if (pick.includes('away') || pick.includes('ext') || pick === '2' || pick.includes(' 2 ')) isWin = a > h;
        else if (pick.includes('draw') || pick.includes('nul') || pick === 'x' || pick.includes(' x ')) isWin = h === a;
        else if (pick.includes('+1.5') || pick.includes('over 1.5')) isWin = total > 1.5;
        else if (pick.includes('-1.5') || pick.includes('under 1.5')) isWin = total < 1.5;
        else if (pick.includes('+2.5') || pick.includes('over 2.5') || pick === 'over25') isWin = total > 2.5;
        else if (pick.includes('-2.5') || pick.includes('under 2.5') || pick === 'under25') isWin = total < 2.5;
        else if (pick.includes('+3.5') || pick.includes('over 3.5')) isWin = total > 3.5;
        else if (pick.includes('-3.5') || pick.includes('under 3.5')) isWin = total < 3.5;
        else if (pick.includes('btts') || pick.includes('marquent') || pick.includes('oui')) isWin = h > 0 && a > 0;
        else isVerifiable = false;
    }

    if (isVerifiable) {
        verifiableCount++;
        if (isWin) {
            wins++;
            totalProfit += 0.85;
        } else {
            totalProfit -= 1;
        }
    }
});

const winRate = verifiableCount > 0 ? Math.round((wins / verifiableCount) * 100) : 0;
console.log(`\n--- RÉSULTATS POUR HIER ---`);
console.log(`Matchs vérifiables: ${verifiableCount}`);
console.log(`Victoires: ${wins}`);
console.log(`Taux de Réussite: ${winRate}%`);
console.log(`Profit / ROI: ${totalProfit.toFixed(2)} Unités`);
