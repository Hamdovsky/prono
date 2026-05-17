/**
 * newsCache.js — In-memory TTL cache for news + lineup data.
 * Avoids re-fetching the same match's news within the TTL window.
 * Falls back to file-system persistence so cache survives server restarts.
 */

const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'news_cache.json');
const TTL_MS     = 2 * 60 * 60 * 1000; // 2 hours

let _cache = {};   // { [key]: { data, expiresAt } }

// ── Persistence ────────────────────────────────────────────────────────────────

function _load() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            const now = Date.now();
            // Discard already-expired entries on load
            for (const [k, v] of Object.entries(raw)) {
                if (v.expiresAt > now) _cache[k] = v;
            }
            console.log(`📦 [NewsCache] Loaded ${Object.keys(_cache).length} cached entries from disk.`);
        }
    } catch (_) {}
}

function _persist() {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2), 'utf8');
    } catch (_) {}
}

// Load on startup
_load();

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a cached news entry for the given match ID.
 * Returns null if not cached or expired.
 */
function get(matchId) {
    const entry = _cache[matchId];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        delete _cache[matchId];
        return null;
    }
    return entry.data;
}

/**
 * Store a news entry in the cache.
 * @param {string} matchId
 * @param {object} data  — the full intel object from getMatchIntelligence
 * @param {number} ttlMs — override TTL (defaults to 2h)
 */
function set(matchId, data, ttlMs = TTL_MS) {
    _cache[matchId] = { data, expiresAt: Date.now() + ttlMs };
    _persist();
}

/**
 * Invalidate a specific entry (e.g. force refresh).
 */
function invalidate(matchId) {
    delete _cache[matchId];
    _persist();
}

/**
 * Purge all entries for matches whose game time has passed.
 * Called by the cron sweeper periodically.
 */
function sweep() {
    const now      = Date.now();
    const before   = Object.keys(_cache).length;
    for (const [k, v] of Object.entries(_cache)) {
        if (v.expiresAt <= now) delete _cache[k];
    }
    const after = Object.keys(_cache).length;
    if (before !== after) {
        console.log(`🧹 [NewsCache] Swept ${before - after} expired entries. Remaining: ${after}`);
        _persist();
    }
}

/**
 * Returns cache stats for the /api/news-watch endpoint.
 */
function stats() {
    const now = Date.now();
    let active = 0, expired = 0;
    for (const v of Object.values(_cache)) {
        v.expiresAt > now ? active++ : expired++;
    }
    return { active, expired, total: Object.keys(_cache).length };
}

module.exports = { get, set, invalidate, sweep, stats };
