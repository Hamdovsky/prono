/**
 * TITANIUM DETERMINISTIC UTILITY
 * Provides seeded random number generation for consistent AI results.
 */

class SeededRandom {
    constructor(seed) {
        this.seed = this.hashString(String(seed));
    }

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
    }

    // LCG Algorithm for seeded randomness
    next() {
        this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
        return this.seed / 4294967296;
    }

    range(min, max) {
        return min + this.next() * (max - min);
    }

    floor(min, max) {
        return Math.floor(this.range(min, max));
    }
}

module.exports = SeededRandom;
