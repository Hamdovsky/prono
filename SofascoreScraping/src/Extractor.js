const { TEAM_ALIAS_MAP } = require('../../config/teamAliases');

class Extractor {
    static normalizeTeamName(name) {
        if (!name) return name;
        return TEAM_ALIAS_MAP[name] || name;
    }

    static extractMatch(event) {
        if (!event || !event.id) return null;

        let homeName = event.homeTeam?.name;
        let awayName = event.awayTeam?.name;
        if (!homeName || !awayName) return null;

        // Apply Alias Normalization
        homeName = this.normalizeTeamName(homeName);
        awayName = this.normalizeTeamName(awayName);

        const tournament = event.tournament?.uniqueTournament || event.tournament || {};
        const category = event.tournament?.category || {};

        const tournamentName = tournament.name || 'Unknown';
        const categoryName = category.name || 'Uncategorized';
        const tournamentId = tournament.id ? tournament.id.toString() : null;
        const categoryId = category.id ? category.id.toString() : null;

        const statusType = event.status?.type || 'notstarted';
        let status = 'scheduled';

        if (statusType === 'finished') status = 'finished';
        else if (statusType === 'inprogress' || statusType === 'live') status = 'live';
        else status = 'scheduled';

        // The frontend handles formatting based on startTimestamp
        let timeOrStatus = status === 'scheduled' ? 'Scheduled' : (status === 'finished' ? 'FT' : 'LIVE');

        const scoreHome = event.homeScore?.current || 0;
        const scoreAway = event.awayScore?.current || 0;

        const parseInitOdds = (o) => {
            if (!o) return null;
            if (o.decimalValue) return parseFloat(o.decimalValue);
            if (o.fractionalValue && o.fractionalValue.includes('/')) {
                const [n, d] = o.fractionalValue.split('/');
                return parseFloat(((parseFloat(n) / parseFloat(d)) + 1).toFixed(3));
            }
            return null;
        };

        const match = {
            id: event.id.toString(),
            league: tournamentName,
            category_name: categoryName,
            category_id: categoryId,
            tournament_name: tournamentName,
            tournament_id: tournamentId,
            category_flag: category.slug || category.name?.toLowerCase().replace(/\s+/g, '-'),
            timeOrStatus,
            home: homeName,
            away: awayName,
            score: { home: scoreHome, away: scoreAway },
            status,
            homeTeam: homeName,
            awayTeam: awayName,
            home_team_id: event.homeTeam?.id?.toString(),
            away_team_id: event.awayTeam?.id?.toString(),
            country_iso: (category.alpha2 || category.slug || '').toUpperCase(),
            startTimestamp: event.startTimestamp,
            // 🌍 [TITANIUM ULTRA] Environmental & Advanced Metadata
            weather_temp: event.details?.weather?.temperature,
            weather_desc: event.details?.weather?.description,
            attendance: event.details?.attendance,
            stadium_capacity: event.details?.stadiumCapacity,
            last_updated: Date.now(),
            odds_home: parseInitOdds(event.mainOdds?.home) || parseInitOdds(event.homeOdds),
            odds_draw: parseInitOdds(event.mainOdds?.draw) || parseInitOdds(event.drawOdds),
            odds_away: parseInitOdds(event.mainOdds?.away) || parseInitOdds(event.awayOdds)
        };
        return match;
    }

    static classifyMatch(timeOrStatus) {
        // Fallback for older code if still needed
        return 'PRE_MATCH';
    }

    static formatStatistics(statsData) {
        const flattened = [];
        if (!statsData || !statsData.statistics) return { stats: [], lineups: { home: [], away: [] } };

        statsData.statistics.forEach(period => {
            if (period.period === 'ALL') {
                period.groups.forEach(group => {
                    group.statisticsItems.forEach(item => {
                        flattened.push({
                            category: item.name,
                            homeValue: item.home,
                            awayValue: item.away
                        });
                    });
                });
            }
        });

        // Lineups can be fetched separately if needed, but not strictly required for pre-match
        return { stats: flattened, lineups: { home: [], away: [] } };
    }
}

module.exports = Extractor;
