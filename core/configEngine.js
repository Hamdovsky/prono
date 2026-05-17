const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

class ConfigEngine {
    constructor() {
        this.config = {
            SOURCE_MODE: 'FLASHSCORE_LOCAL',
            scraperUrl: 'https://api.soccer-scraper.io/v3/live',
            thresholds: { min_confidence: 75, max_odds: 20, cards: 4, corners: 8, goals: 1.5 },
            scraper: { timeout: 10000, retries: 3 },
            autoPurge: true,
            strategy: 'Balanced',
            SMART_SCAN_ENABLED: true,
            WEBHOOK_ENABLED: true,
            SYNC_PRIORITY: 'HIGH',
            DEEP_NEWS_ENABLED: false // 🛡️ [SAFETY] Disabled to prevent timeouts during massive scans
        };
        this.load();
    }

    load() {
        if (fs.existsSync(CONFIG_FILE)) {
            try {
                const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
                this.config = { ...this.config, ...saved };
                logger.info('⚙️  [CONFIG] Persistent configuration loaded');
            } catch (e) {
                logger.error('❌ [CONFIG] Failed to load config.json', e);
            }
        }
    }

    async save() {
        try {
            await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
            logger.info('💾 [CONFIG] Configuration saved to disk');
            return true;
        } catch (e) {
            logger.error('❌ [CONFIG] Failed to save config.json', e);
            return false;
        }
    }

    async updateEnv(key, value) {
        try {
            let envContent = '';
            if (fs.existsSync(ENV_FILE)) {
                envContent = await fs.promises.readFile(ENV_FILE, 'utf8');
            }

            const lines = envContent.split('\n');
            let found = false;
            const newLines = lines.map(line => {
                if (line.trim().startsWith(`${key}=`)) {
                    found = true;
                    return `${key}=${value}`;
                }
                return line;
            });

            if (!found) {
                newLines.push(`${key}=${value}`);
            }

            await fs.promises.writeFile(ENV_FILE, newLines.join('\n'));
            process.env[key] = value;
            logger.info(`📝 [CONFIG] Updated .env: ${key}`);
            return true;
        } catch (e) {
            logger.error(`❌ [CONFIG] Failed to update .env: ${key}`, e);
            return false;
        }
    }

    get(key, defaultValue) {
        const val = this.config[key];
        return val !== undefined ? val : defaultValue;
    }

    getStrategyParams() {
        const strategy = this.config.strategy || 'Balanced';
        switch (strategy) {
            case 'Defensive':
                return { probMult: 1.1, confMult: 1.1, oddsCap: 5.0, label: '🛡️ DEFENSIVE' };
            case 'Aggressive':
                return { probMult: 0.85, confMult: 0.85, oddsCap: 50.0, label: '🚀 AGGRESSIVE' };
            case 'Balanced':
            default:
                return { probMult: 1.0, confMult: 1.0, oddsCap: 15.0, label: '⚖️ BALANCED' };
        }
    }

    set(key, value) {
        this.config[key] = value;
        return this.save();
    }
}

module.exports = new ConfigEngine();
