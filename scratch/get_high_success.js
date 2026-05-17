const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');

async function getHighSuccess() {
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
    
    const now = Date.now();
    const future48h = now + (48 * 60 * 60 * 1000);
    const candidates = matches.filter(m => {
        const ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
        return ts > now && ts < future48h;
    });

    const rankedCandidates = candidates
        // Sort by win probability instead of just xgboost confidence
        .sort((a,b) => {
            const maxA = Math.max(a.home_win_probability || 0, a.away_win_probability || 0);
            const maxB = Math.max(b.home_win_probability || 0, b.away_win_probability || 0);
            return maxB - maxA;
        })
        .slice(0, 40);

    const enriched = await Promise.all(rankedCandidates.map(m => enrichedPredictions.fastEnrichMatch(m)));

    const picks = enriched
        .filter(m => {
            if (m.enriched?.isTrap || m.isTrap) return false;
            const h = m.home_win_probability || 0;
            const a = m.away_win_probability || 0;
            const d = m.draw_probability || 0;
            const winProb = Math.max(h, a);
            // Must have a clear favorite
            return winProb >= 40 && winProb > d + 5; 
        })
        .sort((a,b) => {
            const maxA = Math.max(a.home_win_probability || 0, a.away_win_probability || 0) + (a.xgboost_confidence || 0);
            const maxB = Math.max(b.home_win_probability || 0, b.away_win_probability || 0) + (b.xgboost_confidence || 0);
            return maxB - maxA;
        })
        // Skip the first 6 we already gave, take the next 6
        .slice(6, 12)
        .map(m => {
            const h = m.home_win_probability || 0;
            const a = m.away_win_probability || 0;
            const d = m.draw_probability || 0;
            
            let base = "1X";
            if (h > a) base = "1X";
            else base = "X2";

            const winningProb = base === '1X' ? h + d : a + d;

            return {
                league: m.league,
                home: m.homeTeam,
                away: m.awayTeam,
                pick: base === '1X' ? "Victoire " + m.homeTeam + " ou Nul (1X)" : "Victoire " + m.awayTeam + " ou Nul (X2)",
                confidence: Math.min(99, Math.round(winningProb)) + "%",
                time: m.timestamp ? new Date(m.timestamp).toLocaleString() : 'N/A'
            };
        });

    console.log(JSON.stringify(picks, null, 2));
    process.exit(0);
}

getHighSuccess().catch(console.error);
