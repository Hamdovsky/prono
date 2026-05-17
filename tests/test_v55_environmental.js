
const eps = require('../core/enriched_predictions');

async function testV55() {
    console.log("🔍 [V55-DIAGNOSTIC] Auditing Environmental Intelligence...\n");

    // ⚖️ Case 1: Strict Referee (Mike Dean style)
    const strictMatch = {
        id: "ref_test_01",
        homeTeam: "Strict Team H",
        awayTeam: "Strict Team A",
        referee_yellow_avg: 6.2, // Extremely strict
        referee_red_avg: 0.4,
        referee_penalties_avg: 0.5,
        league: "Premier League",
        home_win_probability: 45,
        draw_probability: 25,
        away_win_probability: 30
    };

    console.log("--- Testing Referee Strictness ---");
    const resStrict = await eps.fastEnrichMatch(strictMatch);
    console.log(`Referee Profile: ${resStrict.enriched.strategic_reasoning}`);
    console.log(`Cards Predicted: ${resStrict.enriched.predictedCards} (Standard is ~4.0 for PL)`);
    console.log(`Verdict: ${resStrict.verdict}\n`);

    // 🌡️ Case 2: Extreme Heat
    const hotMatch = {
        id: "weather_test_01",
        homeTeam: "Hot Team H",
        awayTeam: "Hot Team A",
        weather_temp: 36, // Extremely hot
        weather_desc: "Clear Sky",
        weather_humidity: 80,
        league: "Saudi Pro League",
        home_win_probability: 40,
        draw_probability: 30,
        away_win_probability: 30,
        teamStats: {
            home: { avgGoalsScored: 2.5, avgGoalsConceded: 1.0 },
            away: { avgGoalsScored: 2.5, avgGoalsConceded: 1.0 }
        }
    };

    console.log("--- Testing Extreme Heat Impact ---");
    const resHot = await eps.fastEnrichMatch(hotMatch);
    console.log(`Weather Narrative: ${resHot.enriched.strategic_reasoning}`);
    console.log(`Under 2.5 Probability: ${resHot.ou_2_5_prob}% (Expected > 60% due to heat)`);
    
    // 🌧️ Case 3: Heavy Rain
    const rainMatch = {
        id: "weather_test_02",
        homeTeam: "Rain Team H",
        awayTeam: "Rain Team A",
        weather_temp: 12,
        weather_desc: "Heavy Rain",
        league: "Ligue 1",
        home_win_probability: 40,
        draw_probability: 30,
        away_win_probability: 30,
        teamStats: {
            home: { avgGoalsScored: 2.0, avgGoalsConceded: 1.0 },
            away: { avgGoalsScored: 2.0, avgGoalsConceded: 1.0 }
        }
    };

    console.log("--- Testing Heavy Rain Impact ---");
    const resRain = await eps.fastEnrichMatch(rainMatch);
    console.log(`Weather Narrative: ${resRain.enriched.strategic_reasoning}`);
}

testV55().catch(console.error);
