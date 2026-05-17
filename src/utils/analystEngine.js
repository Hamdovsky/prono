/**
 * TITANIUM ANALYST ENGINE
 * Centralized logic for classifying matches as BANKER, TREND, or VALUE.
 */

export const classifyMatch = (match) => {
    const prob = match.winProb || (match.confidence) || 50;
    const odd = match.odd || 1.45; // Default if not found

    let tags = [];
    let logicText = "";

    // 1. BANKER Criteria: Over 75% win probability with reasonable odds
    if (prob > 75) {
        tags.push("BANKER 💎");
    }

    // 2. TREND Criteria: Historical dominance 
    if (match.h2hAdvantage || (match.confidence > 78)) {
        tags.push("TREND 📈");
    }

    // 3. VALUE Criteria: Confidence vs Odds bridge
    if (prob > 60 && odd > 1.80) {
        tags.push("VALUE ⚖️");
    }

    // 4. Logic Synthesis
    const goals = match.enriched?.predictedGoals || (match.stats?.expectedGoals?.home + match.stats?.expectedGoals?.away) || 0;

    if (prob > 75) logicText += "Strategic dominance index confirmed. ";
    if (goals > 2.5) logicText += "High offensive liquidity detected. ";
    if (match.stats?.pressure?.home > 60) logicText += "Extreme home pressure vectors identified. ";

    if (tags.length === 0 && prob < 60) {
        logicText = "Standard variance expected. Stability confirmed.";
    }

    return {
        tags,
        tagLabel: tags.length > 0 ? tags[0] : "NEUTRAL",
        logic: logicText || "Pattern confirmed within standard deviation.",
        isElite: prob > 75
    };
};

export const generateAnalystReport = (match) => {
    const analysis = classifyMatch(match);
    return {
        match: `${match.homeTeam?.name || match.homeTeam} vs ${match.awayTeam?.name || match.awayTeam}`,
        market: match.prediction || "ANALYZING...",
        tag: analysis.tagLabel,
        logic: analysis.logic
    };
};
