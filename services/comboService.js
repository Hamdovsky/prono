const fs = require('fs').promises;
const path = require('path');
const logger = require('../core/logger');
const database = require('../core/database');
const enrichedPredictions = require('../core/enriched_predictions');
const ComboGenerator = require('./combo_generator');

const comboGenerator = new ComboGenerator();
const COMBO_HISTORY_FILE = path.join(__dirname, '../data', 'combo_history.json');

/**
 * Service to handle match combinations (combos) generation and history.
 */
class ComboService {
    constructor() {
        this.currentCombos = [];
    }

    async loadHistory() {
        try {
            const data = await fs.readFile(COMBO_HISTORY_FILE, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { entries: [] };
            }
            logger.error(`[ComboService] Error loading history: ${error.message}`);
            return { entries: [] };
        }
    }

    async saveHistory(history) {
        try {
            await fs.mkdir(path.dirname(COMBO_HISTORY_FILE), { recursive: true });
            await fs.writeFile(COMBO_HISTORY_FILE, JSON.stringify(history, null, 2));
        } catch (error) {
            logger.error(`[ComboService] Error saving history: ${error.message}`);
        }
    }

    async refreshCombos() {
        logger.info('🎯 [COMBOS] Refreshing multi-match combos...');
        try {
            const rawMatches = await database.getMatchesByStatuses(['scheduled']);
            const cutoff = Date.now();
            const dayEnd = Date.now() + (24 * 60 * 60 * 1000); 
            
            const upcoming = rawMatches.filter(m => {
                const ts = m.startTimestamp ? m.startTimestamp * 1000 : new Date(m.timestamp).getTime();
                return ts > cutoff && ts < dayEnd && m.source === 'africanobet';
            }).slice(0, 100);

            logger.info(`[COMBOS] Found ${upcoming.length} upcoming matches for enrichment.`);

            if (upcoming.length < 2) {
                logger.warn(`[COMBOS] Not enough matches (${upcoming.length}) to generate combos.`);
                return [];
            }

            const enriched = await enrichedPredictions.enrichMatches(upcoming);
            const combos = comboGenerator.generate(enriched);
            
            if (combos.length > 0) {
                const history = await this.loadHistory();
                const today = new Date().toISOString().split('T')[0];
                
                const existingKeys = new Set(
                    history.entries
                        .filter(e => e.date === today)
                        .map(e => e.legs.map(l => l.id).sort().join('|'))
                );
                
                const newCombos = combos.filter(c => {
                    const key = c.legs.map(l => l.id).sort().join('|');
                    return !existingKeys.has(key);
                });

                if (newCombos.length > 0) {
                    history.entries.unshift(...newCombos);
                    if (history.entries.length > 500) {
                        history.entries = history.entries.slice(0, 500);
                    }
                    await this.saveHistory(history);
                    this.currentCombos = newCombos; 
                    logger.info(`✅ [COMBOS] Generated ${newCombos.length} new combinations for today.`);
                    return newCombos;
                }
            }
            return [];
        } catch (error) {
            logger.error(`[ComboService] Generation error: ${error.message}`);
            return [];
        }
    }

    async getTodayCombos() {
        const today = new Date().toISOString().split('T')[0];
        const history = await this.loadHistory();
        return history.entries.filter(e => e.date === today);
    }
}

module.exports = new ComboService();
