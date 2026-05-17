const jsonpatch = require('fast-json-patch');
const logger = require('../core/logger');

class DeltaEngine {
    constructor() {
        this.previousStates = new Map();
    }

    /**
     * Calculate delta (JSON Patch) between current and previous state
     * @param {string} id - Unique identifier for the object (e.g. matchId)
     * @param {Object} currentState - The new data
     * @returns {Object|null} - The patch array or null if no previous state
     */
    getDelta(id, currentState) {
        if (!this.previousStates.has(id)) {
            this.previousStates.set(id, JSON.parse(JSON.stringify(currentState)));
            return null; // First time, send full payload
        }

        const prevState = this.previousStates.get(id);
        const patch = jsonpatch.compare(prevState, currentState);

        // Update previous state for next time
        this.previousStates.set(id, JSON.parse(JSON.stringify(currentState)));

        return patch.length > 0 ? patch : [];
    }

    /**
     * Clear state for an ID
     */
    clearState(id) {
        this.previousStates.delete(id);
    }

    /**
     * Reset all states
     */
    reset() {
        this.previousStates.clear();
    }
}

module.exports = new DeltaEngine();
