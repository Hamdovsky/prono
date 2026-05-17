const { TEAM_ALIAS_MAP } = require('../../config/teamAliases');

class AliasResolver {
    constructor(db) {
        this.db = db;
        // Local cache to avoid DB hits for every match in a 800+ league batch
        this.cache = new Map(); 

        // 🛡️ [SCHEMA SAFETY] Ensure table exists in case database.js hasn't initialized it
        if (this.db && typeof this.db.exec === 'function') {
            try {
                this.db.exec(`
                    CREATE TABLE IF NOT EXISTS id_master_normalization (
                        sofascore_id TEXT PRIMARY KEY,
                        master_name TEXT NOT NULL,
                        category_name TEXT,
                        last_updated INTEGER
                    );
                    CREATE INDEX IF NOT EXISTS idx_normal_name ON id_master_normalization(master_name);
                `);
            } catch (e) {
                console.error('❌ [ALIAS RESOLVER] Schema Init Error:', e.message);
            }
        } else {
            console.warn('⚠️ [ALIAS RESOLVER] Initialized without a valid database handle. Some features will be disabled.');
        }
    }

    /**
     * Resolves a team name based on its unique ID.
     * ID-anchored normalization is 100% accurate and self-healing.
     */
    resolve(teamId, scrapedName) {
        if (!scrapedName) return scrapedName;
        
        // --- 0. Pre-Clean (Strip common suffixes like CF, FC, CD, etc.) ---
        let cleanName = scrapedName
            .replace(/\s+CF$/i, '')
            .replace(/\s+FC$/i, '')
            .replace(/\s+CD$/i, '')
            .replace(/\s+SC$/i, '')
            .replace(/\s+A\.C\.$/i, '')
            .replace(/\s+A\.F\.C\.$/i, '')
            .trim();

        if (!teamId) return this.fuzzyResolve(cleanName);

        // 1. Check Local RAM Cache
        if (this.cache.has(teamId)) return this.cache.get(teamId);

        // 2. Check Database Master Table
        try {
            const row = this.db.prepare('SELECT master_name FROM id_master_normalization WHERE sofascore_id = ?').get(teamId);
            if (row) {
                this.cache.set(teamId, row.master_name);
                return row.master_name;
            }
        } catch (e) {
            console.error('❌ [ALIAS RESOLVER] DB Error:', e.message);
        }

        // 3. Fallback to existing Alias Map (Text-based)
        const mapped = TEAM_ALIAS_MAP[cleanName] || cleanName;
        
        // 4. If mapped differs from original, auto-register it to the ID for future cycles
        if (mapped !== cleanName) {
            this.register(teamId, mapped);
        }

        return mapped;
    }

    /**
     * Resolves a league name to a standard 'Country - League' format.
     */
    resolveTournament(leagueName, categoryName) {
        if (!leagueName) return 'Other';
        const cat = categoryName || 'Other';
        
        // Avoid duplicate prefixes
        if (leagueName.includes(cat)) return leagueName;
        
        return `${cat} - ${leagueName}`;
    }

    /**
     * Auto-registers an ID to a Master Name.
     * This builds the "Self-Healing" part of the pipeline.
     */
    register(teamId, masterName, category = '') {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO id_master_normalization (sofascore_id, master_name, category_name, last_updated)
                VALUES (?, ?, ?, ?)
            `).run(teamId, masterName, category, Date.now());
            this.cache.set(teamId, masterName);
        } catch (e) {
            console.error('❌ [ALIAS RESOLVER] Registration Error:', e.message);
        }
    }

    /**
     * Levenshtein Distance Algorithm
     * Returns the number of edits to turn string A into string B.
     */
    getDistance(a, b) {
        const rows = a.length + 1;
        const cols = b.length + 1;
        const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

        for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
        for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,      // deletion
                    matrix[i][j - 1] + 1,      // insertion
                    matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }
        return matrix[a.length][b.length];
    }

    getSimilarity(a, b) {
        if (a === b) return 1.0;
        const dist = this.getDistance(a, b);
        const maxLen = Math.max(a.length, b.length);
        if (maxLen === 0) return 1.0;
        return 1.0 - (dist / maxLen);
    }

    /**
     * Fuzzy Match (Levenshtein Fallback)
     * Used only when Team ID is missing or unregistered.
     */
    fuzzyResolve(name) {
        if (!name) return name;

        const normalizedScraped = name.toLowerCase().trim();

        // 1. Check direct Alias Map (O(1))
        if (TEAM_ALIAS_MAP[name]) return TEAM_ALIAS_MAP[name];

        // 2. Fuzzy Match against Registered Master Names (O(N))
        let bestMatch = null;
        let highestSimilarity = 0;
        const threshold = 0.65; 

        try {
            const masters = this.db.prepare('SELECT master_name FROM id_master_normalization').all();
            for (const m of masters) {
                const masterName = m.master_name.trim();
                const normalizedMaster = masterName.toLowerCase();
                
                let sim = this.getSimilarity(normalizedScraped, normalizedMaster);

                // 💡 [HEURISTIC] Substring bonus (e.g., "Real Madrid" in "Real Madrid CF")
                if (normalizedScraped.includes(normalizedMaster) || normalizedMaster.includes(normalizedScraped)) {
                    sim += 0.25; // Significant bonus for sub-strings
                }

                if (sim > highestSimilarity) {
                    highestSimilarity = sim;
                    bestMatch = masterName;
                }
            }
        } catch (e) {
            console.error('❌ [FUZZY] DB Error:', e.message);
        }

        if (highestSimilarity >= threshold) {
            return bestMatch;
        }

        return name;
    }

    /**
     * Seed major European IDs (Task 2: Alias Resolver Master DB)
     */
    seedMasterNames() {
        const seed = [
            { id: '2699', name: 'Lazio' },
            { id: '35', name: 'Manchester United' },
            { id: '17', name: 'Manchester City' },
            { id: '2829', name: 'Real Madrid' },
            { id: '38', name: 'Chelsea' },
            { id: '44', name: 'Liverpool' },
            { id: '42', name: 'Arsenal' },
            { id: '2692', name: 'AC Milan' },
            { id: '2687', name: 'Juventus' },
            { id: '2672', name: 'Bayern München' },
            { id: '1644', name: 'Paris Saint-Germain' },
            { id: '33', name: 'Tottenham Hotspur' },
            { id: '2673', name: 'Borussia Dortmund' },
            { id: '2697', name: 'Inter' },
            { id: '2817', name: 'Barcelona' }
        ];

        seed.forEach(s => this.register(s.id, s.name));
        console.log(`📦 [ALIAS RESOLVER] Seeded ${seed.length} elite master names.`);
    }
}

module.exports = AliasResolver;
