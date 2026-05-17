/**
 * Team Name Alias Map — "The Alias Fix"
 * Normalizes variations across different scraping sources to a single standard.
 */

const TEAM_ALIAS_MAP = {
    // ENGLAND
    "Man Utd": "Manchester United",
    "Man United": "Manchester United",
    "Manchester Utd": "Manchester United",
    "Man City": "Manchester City",
    "Manchester C.": "Manchester City",
    "Spurs": "Tottenham Hotspur",
    "Tottenham": "Tottenham Hotspur",
    "Leicester": "Leicester City",

    // ITALY
    "Milan": "AC Milan",
    "Inter": "Internazionale",
    "Inter Milan": "Internazionale",
    "Juve": "Juventus",
    "AS Roma": "Roma",

    // SPAIN
    "Real": "Real Madrid",
    "Barca": "Barcelona",
    "Atleti": "Atletico Madrid",
    "Athletic": "Athletic Club",

    // GERMANY
    "Bayern": "Bayern Munchen",
    "Leverkusen": "Bayer Leverkusen",
    "Dortmund": "Borussia Dortmund",
    "BVB": "Borussia Dortmund",

    // FRANCE
    "PSG": "Paris Saint-Germain",
    "Lyon": "Olympique Lyonnais",
    "Marseille": "Olympique de Marseille",

    // SAUDI
    "Nassr": "Al-Nassr",
    "Hilal": "Al-Hilal",
    "Ittihad": "Al-Ittihad",
    "Ahli": "Al-Ahli"
};

module.exports = { TEAM_ALIAS_MAP };
