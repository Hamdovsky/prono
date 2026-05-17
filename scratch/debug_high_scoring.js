const database = require('../core/database');

async function checkMatches() {
    const statuses = ['scheduled', 'NOT_STARTED', 'NS'];
    const matches = await database.getMatchesByStatuses(statuses);
    console.log(`Total candidates with status ${statuses}: ${matches.length}`);

    const now = Date.now();
    const future48h = now + (48 * 60 * 60 * 1000);

    const within48h = matches.filter(m => {
        let ts;
        if (m.startTimestamp) {
            ts = m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000;
        } else if (m.timestamp) {
            ts = new Date(m.timestamp).getTime();
        } else {
            return false;
        }
        return ts > (now + 60000) && ts < future48h;
    });

    console.log(`Candidates within 48h: ${within48h.length}`);

    const withProbs = within48h.filter(m => {
        const ouProb = m.ou_2_5_prob || m.ou_25_prob || 0;
        const bttsProb = m.btts_prob || 0;
        return ouProb > 0 || bttsProb > 0;
    });

    console.log(`Candidates with probabilities: ${withProbs.length}`);

    if (withProbs.length > 0) {
        console.log("Sample probabilities:");
        withProbs.slice(0, 10).forEach(m => {
            const ouProb = m.ou_2_5_prob || m.ou_25_prob || 0;
            const bttsProb = m.btts_prob || 0;
            console.log(`${m.homeTeam} vs ${m.awayTeam}: OU=${ouProb}, BTTS=${bttsProb}, OddsH=${m.odds_home}, OddsA=${m.odds_away}`);
        });
    }

    const filtered = within48h.filter(m => {
        const ouProb = m.ou_2_5_prob || m.ou_25_prob || 0;
        const bttsProb = m.btts_prob || 0;
        const oddsH = parseFloat(m.odds_home) || 2.0;
        const oddsA = parseFloat(m.odds_away) || 2.0;
        
        const bestOdds = (oddsH && oddsA) ? Math.min(oddsH, oddsA) : null;
        const isHighIntensity = ouProb >= 65 || (ouProb >= 52 && bttsProb >= 40);
        const hasGoodOdds = !bestOdds || (bestOdds >= 1.20 && bestOdds <= 3.50);
        
        return isHighIntensity && hasGoodOdds;
    });

    console.log(`Matches passing "HIGH SCORING ELITE" filter: ${filtered.length}`);
    process.exit(0);
}

checkMatches();
