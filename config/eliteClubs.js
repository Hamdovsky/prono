/**
 * Elite European Clubs Registry - "The Top 50"
 * Matches involving these clubs will be fetched even if their league is not pinned.
 */

const ELITE_CLUBS = [
    // ENGLAND - Big 6 +
    "Manchester City", "Arsenal", "Liverpool", "Aston Villa", "Tottenham Hotspur", 
    "Manchester United", "Newcastle United", "Chelsea", "West Ham United",

    // SPAIN - Top Tier
    "Real Madrid", "Barcelona", "Atletico Madrid", "Girona", "Athletic Club", "Real Sociedad",

    // ITALY - Giant Clubs
    "Inter", "Milan", "Juventus", "Atalanta", "Roma", "Lazio", "Napoli", "Fiorentina",

    // GERMANY - Powerhouses
    "Bayer Leverkusen", "Bayern Munchen", "Stuttgart", "RB Leipzig", "Borussia Dortmund", "Eintracht Frankfurt",

    // FRANCE
    "Paris Saint-Germain", "Monaco", "Lille", "Brest", "Nice", "Lyon", "Marseille",

    // PORTUGAL & NETHERLANDS
    "Sporting CP", "Benfica", "Porto", "PSV Eindhoven", "Feyenoord", "Ajax",

    // ARABIC GIANTS (Pinned as per user focus)
    "Al-Hilal", "Al-Nassr", "Al-Ittihad", "Al-Ahli",

    // OTHER EUROPEAN ELITES
    "Galatasaray", "Fenerbahce", "Club Brugge", "Rangers", "Celtic"
];

// Normalized Search Set (Lowercase for matching)
const ELITE_CLUBS_SEARCH = new Set(ELITE_CLUBS.map(c => c.toLowerCase()));

module.exports = { ELITE_CLUBS, ELITE_CLUBS_SEARCH };
