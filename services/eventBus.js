const EventEmitter = require('events');
const logger = require('../core/logger');

class GlobalEventBus extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(100);
    }

    /**
     * Emit a match update event
     * @param {Object} match - The updated match data
     * @param {Object} prevMatch - The previous match data (optional)
     */
    emitMatchUpdate(match, prevMatch = null) {
        this.emit('match_updated', {
            match,
            prevMatch,
            timestamp: Date.now()
        });
    }

    /**
     * Emit a scraper status event
     */
    emitScraperStatus(status) {
        this.emit('scraper_status', {
            ...status,
            timestamp: Date.now()
        });
    }
}

// Singleton instances
const eventBus = new GlobalEventBus();

module.exports = eventBus;
