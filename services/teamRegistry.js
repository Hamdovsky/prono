/**
 * Team Registry — Data Integrity Module
 * Fuzzy matches scraped team names against known teams using Levenshtein distance.
 * Auto-builds registry from historical match data — no manual maintenance needed.
 */

// Levenshtein distance (zero dependencies)
function levenshtein(a, b) {
    const matrix = [];
    const aLen = a.length;
    const bLen = b.length;

    if (aLen === 0) return bLen;
    if (bLen === 0) return aLen;

    for (let i = 0; i <= bLen; i++) matrix[i] = [i];
    for (let j = 0; j <= aLen; j++) matrix[0][j] = j;

    for (let i = 1; i <= bLen; i++) {
        for (let j = 1; j <= aLen; j++) {
            const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,       // deletion
                matrix[i][j - 1] + 1,       // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }
    return matrix[bLen][aLen];
}

// Normalize for comparison (lowercase, strip accents, trim)
function normalize(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/[^a-z0-9\s]/g, '')     // strip specials
        .replace(/\s+/g, ' ');
}

class TeamRegistry {
    constructor(db) {
        this.db = db;
        this.knownTeams = [];
        this.loadRegistry();
    }

    async init() {
        await this.loadRegistry();
    }

    async loadRegistry() {
        try {
            const rows = await this.db.prepare('SELECT name, normalized FROM team_registry').all();
            this.knownTeams = rows.map(r => ({ name: r.name, normalized: r.normalized }));
        } catch (e) {
            this.knownTeams = [];
        }
    }

    // Register a team name (called on every match insert)
    async register(teamName, league) {
        if (!teamName || teamName.length < 2) return;
        const norm = normalize(teamName);
        try {
            await this.db.prepare(
                `INSERT INTO team_registry (name, normalized, league, last_seen) VALUES (?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET last_seen = EXCLUDED.last_seen`
            ).run(teamName, norm, league || 'Unknown', Date.now());

            // Update in-memory cache if new
            if (!this.knownTeams.find(t => t.normalized === norm)) {
                this.knownTeams.push({ name: teamName, normalized: norm });
            }
        } catch (e) { /* ignore errors */ }
    }

    // Fuzzy match a scraped name against known teams
    match(scrapedName) {
        if (!scrapedName || this.knownTeams.length === 0) {
            return { matched: scrapedName, confidence: 1.0, original: scrapedName, isNew: true };
        }

        const normScraped = normalize(scrapedName);

        // Exact match shortcut
        const exact = this.knownTeams.find(t => t.normalized === normScraped);
        if (exact) return { matched: exact.name, confidence: 1.0, original: scrapedName, isNew: false };

        // Fuzzy search
        let bestMatch = null;
        let bestDistance = Infinity;

        for (const known of this.knownTeams) {
            const dist = levenshtein(normScraped, known.normalized);
            if (dist < bestDistance) {
                bestDistance = dist;
                bestMatch = known;
            }
        }

        if (!bestMatch) {
            return { matched: scrapedName, confidence: 1.0, original: scrapedName, isNew: true };
        }

        const maxLen = Math.max(normScraped.length, bestMatch.normalized.length);
        const confidence = maxLen > 0 ? 1 - (bestDistance / maxLen) : 1;

        return {
            matched: bestMatch.name,
            confidence: Math.round(confidence * 100) / 100,
            original: scrapedName,
            distance: bestDistance,
            isNew: false,
            isSuspicious: confidence < 0.7
        };
    }

    // Validate both team names in a match
    validateMatch(homeTeam, awayTeam) {
        const homeCheck = this.match(homeTeam);
        const awayCheck = this.match(awayTeam);

        const integrity = (homeCheck.confidence >= 0.7 && awayCheck.confidence >= 0.7) ? 'HIGH'
            : (homeCheck.confidence >= 0.5 && awayCheck.confidence >= 0.5) ? 'MEDIUM'
                : 'LOW';

        return {
            home: homeCheck,
            away: awayCheck,
            integrity,
            warnings: [
                ...(homeCheck.isSuspicious ? [`Home team "${homeCheck.original}" → "${homeCheck.matched}" (${(homeCheck.confidence * 100).toFixed(0)}%)`] : []),
                ...(awayCheck.isSuspicious ? [`Away team "${awayCheck.original}" → "${awayCheck.matched}" (${(awayCheck.confidence * 100).toFixed(0)}%)`] : [])
            ]
        };
    }
}

module.exports = TeamRegistry;
