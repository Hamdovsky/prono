/**
 * MatchAuditor
 * Responsible for cleaning, deduplicating, and validating match data.
 */
class MatchAuditor {

    /**
     * Main audit function to process a batch of matches.
     * @param {Array} data - Raw match data from scraper
     * @returns {Array} - Cleaned, deduplicated, and validated matches
     */
    static auditMatches(data) {
        if (!Array.isArray(data)) return [];

        const uniqueMatches = new Map();

        data.forEach(match => {
            // 1. Validation: Skip invalid dates or missing teams
            if (!this.isValidMatch(match)) return;

            // 2. Normalization: Clean names
            const home = this.normalizeTeamName(match.homeTeam);
            const away = this.normalizeTeamName(match.awayTeam);

            // 3. ID Generation: Create deterministic ID
            const matchId = this.generateMatchId(home, away, match.startTime || match.time);

            // 4. Debug Filtering: Skip debug/test matches
            if (this.isDebugMatch(home, away, match.league)) return;

            // 5. Deduplication
            if (uniqueMatches.has(matchId)) {
                // Logic to keep the better version can be expanded here
                // For now, simple overwrite or keep first?
                // Let's keep the one that looks "more complete" or later
                const existing = uniqueMatches.get(matchId);
                if (this.isBetterMatch(match, existing)) {
                    uniqueMatches.set(matchId, { ...match, id: matchId, homeTeam: home, awayTeam: away });
                }
            } else {
                uniqueMatches.set(matchId, { ...match, id: matchId, homeTeam: home, awayTeam: away });
            }
        });

        // Convert Map back to array
        return Array.from(uniqueMatches.values());
    }

    static isValidMatch(match) {
        if (!match.homeTeam || !match.awayTeam) return false;
        // Check for "Invalid Date" string or other corruptions
        if (match.time === 'Invalid Date' || match.startTime === 'Invalid Date') return false;
        return true;
    }

    static normalizeTeamName(teamInput) {
        let name = typeof teamInput === 'object' ? (teamInput?.name || '') : String(teamInput || '');

        // Title Case and remove odd symbols
        return name
            .trim()
            .toLowerCase()
            .replace(/[^\w\s\-]/g, '') // Remove non-word chars except space and hyphen
            .split(/\s+/)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    }

    static generateMatchId(home, away, timeStr) {
        const homeSlug = this.slugify(home);
        const awaySlug = this.slugify(away);

        // Date Handling: Critical for ID Stability
        let datePart = '';
        const now = new Date();

        // Helper: Get YYYYMMDD from a Date object
        const getYYYYMMDD = (date) => date.toISOString().slice(0, 10).replace(/-/g, '');

        if (!timeStr) {
            // No time provided -> assume today
            datePart = getYYYYMMDD(now);
        } else if (timeStr.includes("'") || timeStr.toLowerCase() === 'live') {
            // Live match -> definitely today
            datePart = getYYYYMMDD(now);
        } else {
            // Scheduled match -> parse date
            const d = new Date(timeStr);
            if (!isNaN(d.getTime())) {
                datePart = getYYYYMMDD(d);
            } else {
                // Parse failed -> fallback to today
                datePart = getYYYYMMDD(now);
            }
        }

        return `${homeSlug}_vs_${awaySlug}_${datePart}`;
    }

    static slugify(text) {
        return text
            .toString()
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')     // Replace spaces with -
            .replace(/[^\w\-]+/g, '') // Remove all non-word chars
            .replace(/\-\-+/g, '-');  // Replace multiple - with single -
    }

    static isDebugMatch(home, away, league) {
        const terms = ['debug', 'minor home 0', 'test team'];
        const fullString = `${home} ${away} ${typeof league === 'string' ? league : (league?.name || '')}`.toLowerCase();
        return terms.some(term => fullString.includes(term));
    }

    static lastPredictionTimes = new Map();

    /**
     * Checks if a match should be predicted based on a 5-minute cooldown.
     * @param {string} matchId 
     * @returns {boolean}
     */
    static shouldPredict(matchId) {
        if (!matchId) return false;

        const now = Date.now();
        const lastPrediction = this.lastPredictionTimes.get(matchId);

        // 5 Minutes Cooldown (300,000 ms)
        if (lastPrediction && (now - lastPrediction < 300000)) {
            return false;
        }

        // Update timestamp
        this.lastPredictionTimes.set(matchId, now);

        // Cleanup old keys periodically (optional basic cleanup)
        if (this.lastPredictionTimes.size > 1000) {
            const cutoff = now - 3600000; // 1 hour
            for (const [key, time] of this.lastPredictionTimes) {
                if (time < cutoff) this.lastPredictionTimes.delete(key);
            }
        }

        return true;
    }

    static isBetterMatch(newMatch, existingMatch) {
        // Example logic: prefer one with higher confidence
        if ((newMatch.confidence || 0) > (existingMatch.confidence || 0)) return true;
        // Prefer live over not live?
        if (newMatch.isLive && !existingMatch.isLive) return true;
        return false;
    }
}

module.exports = MatchAuditor;
