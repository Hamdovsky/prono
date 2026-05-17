/**
 * Schemas
 * تعريف لهياكل البيانات الأساسية لضمان الاتساق بين الخدمات.
 */

class Schemas {
    /**
     * التحقق من سلامة بيانات المباراة الأساسية
     */
    validateMatch(match) {
        if (!match) throw new Error("Match data is missing");
        
        // Normalize keys
        match.homeTeam = match.homeTeam || match.hometeam || match.home_team || "Unknown Home";
        match.awayTeam = match.awayTeam || match.awayteam || match.away_team || "Unknown Away";
        match.league = match.league || match.league_name || "Unknown League";
        
        // Ensure numeric types
        match.id = parseInt(match.id) || 0;
        match.home_market_value = parseFloat(match.home_market_value || 0);
        match.away_market_value = parseFloat(match.away_market_value || 0);
        
        return match;
    }

    /**
     * هيكل موحد لنتيجة الإثراء (Enrichment Result)
     */
    normalizeResult(match, enrichedData = {}) {
        return {
            id: match.id,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            league: match.league,
            verdict: enrichedData.verdict || "UNDER ANALYSIS",
            confidence: enrichedData.confidence || 50,
            xgboost_confidence: enrichedData.xgboost_confidence || 0.5,
            power_score: enrichedData.power_score || 60,
            predictions: enrichedData.predictions || [],
            metrics: {
                home_win_prob: enrichedData.home_win_probability || 0,
                away_win_prob: enrichedData.away_win_probability || 0,
                draw_prob: enrichedData.draw_probability || 0,
                chaos_level: enrichedData.chaos_level || 50
            },
            news: enrichedData.news_data || null,
            market: enrichedData.market_intelligence || null,
            trace: enrichedData.trace || null
        };
    }
}

module.exports = new Schemas();
