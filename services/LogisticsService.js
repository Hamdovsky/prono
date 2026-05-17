/**
 * LogisticsService.js — [ELITE V26]
 * Calculates Travel Fatigue based on geographic distance and schedule density.
 */

const CITY_COORDINATES = {
    // ENGLAND
    "London": { lat: 51.5074, lng: -0.1278 },
    "Manchester": { lat: 53.4808, lng: -2.2426 },
    "Liverpool": { lat: 53.4084, lng: -2.9916 },
    "Birmingham": { lat: 52.4862, lng: -1.8904 },
    "Newcastle": { lat: 54.9783, lng: -1.6178 },
    "Brighton": { lat: 50.8225, lng: -0.1372 },
    
    // SPAIN
    "Madrid": { lat: 40.4168, lng: -3.7038 },
    "Barcelona": { lat: 41.3851, lng: 2.1734 },
    "Seville": { lat: 37.3891, lng: -5.9845 },
    "Valencia": { lat: 39.4699, lng: -0.3763 },
    "Bilbao": { lat: 43.2630, lng: -2.9350 },
    
    // GERMANY
    "Munich": { lat: 48.1351, lng: 11.5820 },
    "Dortmund": { lat: 51.5136, lng: 7.4653 },
    "Berlin": { lat: 52.5200, lng: 13.4050 },
    "Leipzig": { lat: 51.3397, lng: 12.3731 },
    "Leverkusen": { lat: 51.0459, lng: 7.0192 },
    
    // ITALY
    "Rome": { lat: 41.9028, lng: 12.4964 },
    "Milan": { lat: 45.4642, lng: 9.1900 },
    "Turin": { lat: 45.0703, lng: 7.6869 },
    "Naples": { lat: 40.8518, lng: 14.2681 },
    "Florence": { lat: 43.7696, lng: 11.2558 },
    
    // FRANCE
    "Paris": { lat: 48.8566, lng: 2.3522 },
    "Marseille": { lat: 43.2965, lng: 5.3698 },
    "Lyon": { lat: 45.7640, lng: 4.8357 },
    "Monaco": { lat: 43.7384, lng: 7.4246 },
    "Lille": { lat: 50.6292, lng: 3.0573 },
    
    // OTHERS
    "Lisbon": { lat: 38.7223, lng: -9.1393 },
    "Porto": { lat: 41.1579, lng: -8.6291 },
    "Amsterdam": { lat: 52.3676, lng: 4.9041 },
    "Riyadh": { lat: 24.7136, lng: 46.6753 },
    "Jeddah": { lat: 21.5433, lng: 39.1728 },
    "Cairo": { lat: 30.0444, lng: 31.2357 },
    "Casablanca": { lat: 33.5731, lng: -7.5898 }
};

const TEAM_TO_CITY = {
    // UK
    "Arsenal": "London", "Chelsea": "London", "Tottenham": "London", "West Ham": "London", "Crystal Palace": "London",
    "Manchester City": "Manchester", "Manchester United": "Manchester",
    "Liverpool": "Liverpool", "Everton": "Liverpool",
    "Aston Villa": "Birmingham", "Newcastle United": "Newcastle", "Brighton & Hove Albion": "Brighton",
    
    // SPAIN
    "Real Madrid": "Madrid", "Atletico Madrid": "Madrid", "Getafe": "Madrid", "Rayo Vallecano": "Madrid",
    "Barcelona": "Barcelona", "Espanyol": "Barcelona",
    "Sevilla": "Seville", "Real Betis": "Seville",
    "Valencia": "Valencia", "Athletic Club": "Bilbao",
    
    // GERMANY
    "Bayern München": "Munich", "Borussia Dortmund": "Dortmund", "Hertha BSC": "Berlin", "Union Berlin": "Berlin",
    "RB Leipzig": "Leipzig", "Bayer 04 Leverkusen": "Leverkusen",
    
    // ITALY
    "AS Roma": "Rome", "Lazio": "Rome",
    "AC Milan": "Milan", "Inter": "Milan",
    "Juventus": "Turin", "Torino": "Turin",
    "Napoli": "Naples", "Fiorentina": "Florence",
    
    // FRANCE
    "Paris Saint-Germain": "Paris", "Olympique de Marseille": "Marseille",
    "Olympique Lyonnais": "Lyon", "AS Monaco": "Monaco", "Lille OSC": "Lille"
};

class LogisticsService {
    /**
     * Resolves a city name from a team name using fuzzy/exact mapping.
     */
    static resolveCity(teamName) {
        if (!teamName) return "Unknown";
        // Simple exact match
        if (TEAM_TO_CITY[teamName]) return TEAM_TO_CITY[teamName];
        
        // Simple fuzzy/contains match
        for (const [team, city] of Object.entries(TEAM_TO_CITY)) {
            if (teamName.includes(team) || team.includes(teamName)) return city;
        }
        
        return "Unknown";
    }

    /**
     * Calculate Haversine distance between two points (km)
     */
    static getDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    /**
     * Estimate Travel Fatigue Score (0-100)
     */
    static calculateFatigue(departureCity, arrivalCity, daysRest) {
        // Fallback for same city (Derby)
        if (departureCity !== "Unknown" && arrivalCity !== "Unknown" && departureCity === arrivalCity) {
            return { score: 5, distance: 0, impact: 'LOW' };
        }

        const coord1 = CITY_COORDINATES[departureCity];
        const coord2 = CITY_COORDINATES[arrivalCity];

        if (!coord1 || !coord2) {
            // If cities are in the same league but unknown, assume medium-low fatigue
            return { score: 20, distance: 300, impact: 'LOW' };
        }

        const distance = this.getDistance(coord1.lat, coord1.lng, coord2.lat, coord2.lng);
        
        let baseFatigue = (distance / 500) * 15;
        const restMultiplier = daysRest < 3 ? (3 / Math.max(1, daysRest)) : 1;
        let totalFatigue = baseFatigue * restMultiplier;

        return {
            score: Math.min(95, Math.round(totalFatigue)),
            distance: Math.round(distance),
            impact: totalFatigue > 60 ? 'HIGH' : (totalFatigue > 30 ? 'MEDIUM' : 'LOW')
        };
    }
}

module.exports = LogisticsService;
