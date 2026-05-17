const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');

async function getSafe() {
    const matches = await database.getMatchesByStatuses(['scheduled', 'NOT_STARTED', 'NS']);
    
    const now = Date.now();
    const future48h = now + (48 * 60 * 60 * 1000);
    const candidates = matches.filter(m => {
        const ts = m.startTimestamp ? (m.startTimestamp > 1e11 ? m.startTimestamp : m.startTimestamp * 1000) : 0;
        return ts > now && ts < future48h;
    });

    const rankedCandidates = candidates
        .sort((a,b) => (b.xgboost_confidence || 0) - (a.xgboost_confidence || 0))
        .slice(0, 40);

    const enriched = await Promise.all(rankedCandidates.map(m => enrichedPredictions.fastEnrichMatch(m)));

    const picks = enriched
        .filter(m => {
            if (m.enriched?.isTrap || m.isTrap) return false;
            const winProb = Math.max(m.home_win_probability || 0, m.away_win_probability || 0);
            const confidence = m.enriched?.confidence || 0;
            return winProb >= 48 || confidence >= 65 || m.neural_boost;
        })
        .sort((a,b) => {
            const aScore = (a.enriched?.winnerProbability || 0) + (a.xgboost_confidence || 0);
            const bScore = (b.enriched?.winnerProbability || 0) + (b.xgboost_confidence || 0);
            return bScore - aScore;
        })
        .slice(0, 6)
        .map(m => {
            const h = m.home_win_probability || 0;
            const a = m.away_win_probability || 0;
            const d = m.draw_probability || 0;
            
            let base = "X";
            if (h > d && h > a) base = "1";
            else if (a > d && a > h) base = "2";

            const total = (h + a + d) || 100;
            const winningProb = base === '1' ? h : base === '2' ? a : d;
            const realConfidence = Math.round((winningProb / total) * 100);

            return {
                league: m.league,
                home: m.homeTeam,
                away: m.awayTeam,
                pick: base === '1' ? "Victoire " + m.homeTeam : (base === '2' ? "Victoire " + m.awayTeam : "Match Nul"),
                confidence: realConfidence + "%",
                time: m.timestamp ? new Date(m.timestamp).toLocaleString() : 'N/A'
            };
        });

    console.log(JSON.stringify(picks, null, 2));
    process.exit(0);
}

getSafe().catch(console.error);
