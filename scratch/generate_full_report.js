const fs = require('fs');
const path = require('path');

const dataPath = path.join('c:', 'Users', 'HAMDI', 'Desktop', 'HamdiProno', 'stitch', 'data', 'enriched_africanobet_matches.json');

function getSurgical(m) {
    const pH = m.home_win_probability || 33;
    const pD = m.draw_probability || 33;
    const pA = m.away_win_probability || 33;
    const pOU25 = m.ou_2_5_prob || 50;
    const pBTTS = m.btts_prob || 50;
    
    // Improved HT 0.5 Logic based on stats
    let pHT05 = 60;
    if (m.stats) {
        const hG = m.stats.home?.avgGoalsScored || 1.2;
        const aG = m.stats.away?.avgGoalsScored || 1.1;
        pHT05 = Math.min(95, 55 + ((hG + aG) * 10));
    } else {
        pHT05 = 60 + (pOU25 * 0.2);
    }

    const markets = [
        { type: '1X2', prob: Math.max(pH, pA), label: pH > pA ? `فوز ${m.home_team}` : `فوز ${m.away_team}` },
        { type: 'BTTS', prob: pBTTS, label: 'كلا الفريقين يسجل (BTTS)' },
        { type: 'Over 2.5', prob: pOU25, label: 'أكثر من 2.5 هدف' },
        { type: 'HT 0.5', prob: pHT05, label: 'هدف في الشوط الأول (HT 0.5)' }
    ];

    markets.sort((a, b) => b.prob - a.prob);

    return {
        match: `${m.home_team} vs ${m.away_team}`,
        league: m.tournament || m.category || 'Other',
        time: m.time,
        strongest: markets[0],
        fallback: markets[1],
        confidence: Math.round(markets[0].prob)
    };
}

try {
    const matches = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const analysis = matches.map(getSurgical);
    
    // Group by League
    const groups = {};
    analysis.forEach(a => {
        if (!groups[a.league]) groups[a.league] = [];
        groups[a.league].push(a);
    });

    let report = `# 🔬 التقرير الجراحي الشامل - جميع مباريات اليوم\n`;
    report += `**تاريخ:** 04 مايو 2026 | **عدد المباريات المحللة:** ${analysis.length}\n\n`;

    for (const league in groups) {
        report += `## 🏆 ${league}\n`;
        report += `| المباراة | الوقت | الاختيار الجراحي الأقوى | البديل الإستراتيجي | الثقة |\n`;
        report += `| :--- | :---: | :--- | :--- | :---: |\n`;
        groups[league].forEach(m => {
            report += `| ${m.match} | ${m.time} | **${m.strongest.label}** | ${m.fallback.label} | ${m.confidence}% |\n`;
        });
        report += `\n`;
    }

    fs.writeFileSync('c:/Users/HAMDI/Desktop/HamdiProno/stitch/reports/full_daily_surgery.md', report);
    console.log("✅ Full Daily Surgery report generated.");
} catch (err) {
    console.error(err);
}
