// @ts-nocheck
import jsonpatch from 'fast-json-patch'
import logger from '../core/logger'

class DeltaEngine {
  constructor() {
    this.previousStates = new Map()
  }

  /**
   * Calculate delta (JSON Patch) between current and previous state
   * @param {string} id - Unique identifier for the object (e.g. matchId)
   * @param {Object} currentState - The new data
   * @returns {Object|null} - The patch array or null if no previous state
   */
  getDelta(id, currentState) {
    if (!this.previousStates.has(id)) {
      this.previousStates.set(id, {
        ...JSON.parse(JSON.stringify(currentState)),
        _timestamp: Date.now(),
      })
      return null // First time, send full payload
    }

    const prevState = this.previousStates.get(id)
    const patch = jsonpatch.compare(prevState, currentState)

    // Update previous state for next time
    this.previousStates.set(id, {
      ...JSON.parse(JSON.stringify(currentState)),
      _timestamp: Date.now(),
    })

    return patch.length > 0 ? patch : []
  }

  /**
   * Clear state for an ID
   */
  clearState(id) {
    this.previousStates.delete(id)
  }

  /**
   * Reset all states
   */
  reset() {
    this.previousStates.clear()
  }

  /**
   * Auto-cleanup: remove entries older than 1h (called periodically)
   */
  cleanup() {
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const [id, state] of this.previousStates) {
      if (state._timestamp && state._timestamp < cutoff) this.previousStates.delete(id)
    }
    if (this.previousStates.size > 1000) this.previousStates.clear()
  }
}

export = new DeltaEngine()
