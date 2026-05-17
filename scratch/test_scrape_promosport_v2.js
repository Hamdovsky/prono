const axios = require('axios');

async function scrapePromosport() {
    const url = 'http://www.promosportplus.com/promosport-concours-de-la-semaine';
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = response.data;

        const matches = [];
        const teamStatsRegex = /<strong[^>]*>\s*([^:]+)\s*:\s*(\d+)\s*match\(s\)\s*a\s*(domicile|l'exterieur)\s*<\/strong>\s*<hr>\s*<p>Nombre\s*de\s*victoires\s*:\s*(\d+)<br>Nombre\s*de\s*matchs\s*nuls\s*:\s*(\d+)<br>Nombre\s*de\s*d&eacute;faites\s*:(\d+)<br>Pourcentage\s*Surprise\s*:\s*(\d+)%/g;
        
        let matchData;
        const tempStats = [];
        while ((matchData = teamStatsRegex.exec(html)) !== null) {
            tempStats.push({
                team: matchData[1].trim(),
                games: parseInt(matchData[2]),
                type: matchData[3],
                wins: parseInt(matchData[4]),
                draws: parseInt(matchData[5]),
                losses: parseInt(matchData[6]),
                surprise: parseInt(matchData[7])
            });
        }
        
        // Group them in pairs
        for (let i = 0; i < tempStats.length; i += 2) {
            if (tempStats[i+1]) {
                matches.push({
                    idx: (i / 2) + 1,
                    home: tempStats[i].team,
                    away: tempStats[i+1].team,
                    stats: {
                        home: tempStats[i],
                        away: tempStats[i+1]
                    }
                });
            }
        }
        
        return matches;
    } catch (error) {
        console.error('Scraping error:', error.message);
        return [];
    }
}

// Test
scrapePromosport().then(m => {
    console.log(JSON.stringify(m, null, 2));
    process.exit(0);
});
