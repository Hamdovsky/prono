const fs = require('fs');
const path = require('path');

// Logic for Surgical Selection
function calculateSurgical(m) {
    const pH = m.home_win_probability || 33;
    const pD = m.draw_probability || 33;
    const pA = m.away_win_probability || 33;
    const pOU25 = m.ou_2_5_prob || 50;
    const pBTTS = m.btts_prob || 50;
    
    // Derived HT 0.5 (Over 0.5 HT)
    // Statistical average for HT 0.5 is usually ~70% for matches with high Over 2.5
    const pHT05 = Math.min(95, 60 + (pOU25 * 0.4)); 

    const markets = [
        { type: '1X2', prob: Math.max(pH, pA), label: pH > pA ? `فوز ${m.home_team}` : `فوز ${m.away_team}` },
        { type: 'BTTS', prob: pBTTS, label: 'كلا الفريقين يسجل (BTTS)' },
        { type: 'Over 2.5', prob: pOU25, label: 'أكثر من 2.5 هدف' },
        { type: 'HT 0.5', prob: pHT05, label: 'هدف في الشوط الأول (HT 0.5)' }
    ];

    markets.sort((a, b) => b.prob - a.prob);

    const strongest = markets[0];
    const fallback = markets[1];

    return {
        match: `${m.home_team} vs ${m.away_team}`,
        league: m.tournament || m.category || 'Unknown',
        time: m.time,
        strongest,
        fallback,
        confidence: Math.round(strongest.prob)
    };
}

const dataPath = path.join('c:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', 'data', 'enriched_africanobet_matches.json');

try {
    const matches = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const results = matches.map(calculateSurgical);
    
    // Sort by confidence
    results.sort((a, b) => b.confidence - a.confidence);

    console.log(JSON.stringify(results, null, 2));
} catch (err) {
    console.error(err);
}
