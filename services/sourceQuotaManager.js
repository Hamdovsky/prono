const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

const DEFAULT_LIMITS = {
    footballdata: 20,
    rapidapi: 20
};

const ENV_LIMITS = {
    footballdata: 'FOOTBALLDATA_DAILY_LIMIT',
    rapidapi: 'RAPIDAPI_DAILY_LIMIT'
};

const ENV_ENABLED = {
    footballdata: 'FOOTBALLDATA_ENABLED',
    rapidapi: 'RAPIDAPI_ENABLED'
};

function usageFileFor(source) {
    return path.resolve(process.cwd(), 'data', `${source}_usage.json`);
}

class SourceQuotaManager {
    constructor(source) {
        this.source = source;
        this.limit = parseInt(process.env[ENV_LIMITS[source]] || String(DEFAULT_LIMITS[source] || 20), 10);
        this.file = usageFileFor(source);
    }

    _today() {
        return new Date().toISOString().split('T')[0];
    }

    _defaultUsage() {
        return { current_day: this._today(), count: 0, processed_matches: [] };
    }

    _save(usage) {
        const parentDir = path.dirname(this.file);
        if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(usage, null, 2), 'utf8');
    }

    _getUsage() {
        const today = this._today();
        const fallback = this._defaultUsage();

        try {
            if (!fs.existsSync(this.file)) {
                this._save(fallback);
                return fallback;
            }

            const usage = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (usage.current_day !== today) {
                logger.info(`[${this.source.toUpperCase()}] New day detected (${today}). Resetting quota.`);
                const reset = this._defaultUsage();
                this._save(reset);
                return reset;
            }

            if (!Array.isArray(usage.processed_matches)) usage.processed_matches = [];
            usage.count = usage.processed_matches.length;
            return usage;
        } catch (e) {
            logger.error(`[${this.source.toUpperCase()}] Failed to load usage file: ${e.message}`);
            return fallback;
        }
    }

    isEnabled() {
        return process.env[ENV_ENABLED[this.source]] === 'true';
    }

    canProcessMatch(matchId) {
        if (!this.isEnabled()) return false;

        const usage = this._getUsage();
        const id = String(matchId);
        if (usage.processed_matches.includes(id)) return true;

        if (usage.count < this.limit) return true;

        logger.warn(`[${this.source.toUpperCase()}] Daily limit of ${this.limit} matches reached. Skipping ${id}.`);
        return false;
    }

    registerMatch(matchId) {
        try {
            const usage = this._getUsage();
            const id = String(matchId);
            if (usage.processed_matches.includes(id)) return usage.count;

            usage.processed_matches.push(id);
            usage.count = usage.processed_matches.length;
            this._save(usage);
            logger.info(`[${this.source.toUpperCase()}] Match ${id} registered. Quota: ${usage.count}/${this.limit}.`);
            return usage.count;
        } catch (e) {
            logger.error(`[${this.source.toUpperCase()}] Failed to register match: ${e.message}`);
            return 0;
        }
    }

    getQuotaStatus() {
        const usage = this._getUsage();
        return {
            date: usage.current_day,
            used: usage.count,
            limit: this.limit,
            remaining: Math.max(0, this.limit - usage.count),
            isActive: this.isEnabled() && usage.count < this.limit
        };
    }
}

module.exports = {
    createQuotaManager: (source) => new SourceQuotaManager(source)
};
