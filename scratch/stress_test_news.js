const newsService = require('../core/services/NewsAnalysisService');

const testHeadlines = [
    "No new injuries reported for the home team.",
    "Team is without any major injury concerns.",
    "Absence of injuries gives the manager a full squad selection.",
    "The squad is clear of any long-term absentees.",
    "Zero injuries in the camp ahead of the derby.",
    "All players are fit and available for selection.",
    "No missing players for the away trip.",
    "Manager confirms no suspended players this week.",
    "Without any doubt, the best XI is ready.",
    "Absence of key striker is NOT the case today.",
    // Mixed negative news to verify normal detection still works
    "Star striker is out for three weeks.",
    "Goalkeeper is injured and missing today."
];

console.log("=============================================================");
console.log("TITANIUM NEWS INTELLIGENCE - NEGATION STRESS TEST");
console.log("=============================================================\n");

testHeadlines.forEach((headline, index) => {
    const result = newsService.calculateNewsScore([headline]);
    const status = result.score >= 0 ? "✅ SUCCESS (Positive/Neutral)" : "❌ FAILURE (Negative)";
    
    console.log(`Test #${index + 1}: "${headline}"`);
    console.log(`- Score: ${result.score}`);
    console.log(`- Attack Mod: ${result.attack.toFixed(2)}`);
    console.log(`- Defense Mod: ${result.defense.toFixed(2)}`);
    console.log(`- Critical Flags: ${result.critical.join(', ')}`);
    console.log(`- Status: ${status}\n`);
});

const batchResult = newsService.calculateNewsScore(testHeadlines.slice(0, 10));
console.log("=============================================================");
console.log("BATCH TEST (10 Negations Together)");
console.log("=============================================================");
console.log(`- Final Score: ${batchResult.score}`);
console.log(`- Resulting Flags: ${batchResult.critical.join(', ')}`);
console.log("=============================================================");
