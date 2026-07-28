const axios = require('axios')
const logger = require('./logger')

const FASTAPI_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'

class PythonService {
  constructor() {
    this.isReady = false
    this._notified = false
    this._failCount = 0
    this._circuitOpen = false
    this._circuitOpenedAt = 0
    this._COOLDOWN_MS = 10 * 60 * 1000
    this._MAX_FAILURES = 3
  }

  _openCircuit() {
    this._circuitOpen = true
    this._circuitOpenedAt = Date.now()
    logger.warn(`[PythonService] Circuit OPEN — no retries for ${this._COOLDOWN_MS / 1000}s`)
  }

  _shouldAllow() {
    if (!this._circuitOpen) return true
    if (Date.now() - this._circuitOpenedAt > this._COOLDOWN_MS) {
      this._circuitOpen = false
      this._failCount = 0
      logger.info('[PythonService] Circuit half-open — retrying...')
      return true
    }
    return false
  }

  async checkHealth() {
    try {
      await axios.get(`${FASTAPI_URL}/health`, { timeout: 5000 })
      if (!this.isReady) {
        logger.info(`✅ [PythonService] FastAPI connected at ${FASTAPI_URL}`)
        this.isReady = true
        this._notified = true
      }
      this._failCount = 0
      this._circuitOpen = false
      return true
    } catch (e) {
      if (!this._notified) {
        logger.info(`⏳ [PythonService] FastAPI not reachable at ${FASTAPI_URL} (${e.message})`)
        this._notified = true
      }
      this.isReady = false
      return false
    }
  }

  async predict(matchData, timeoutMs = 180000) {
    if (!this._shouldAllow()) {
      return { success: false, error: 'circuit_open' }
    }

    try {
      const response = await axios.post(`${FASTAPI_URL}/predict`, matchData, {
        timeout: timeoutMs,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      })
      this._failCount = 0
      this._circuitOpen = false
      return response.data
    } catch (error) {
      this._failCount++
      if (this._failCount >= this._MAX_FAILURES) {
        this._openCircuit()
      } else {
        logger.warn(
          `[PythonService] Error (${this._failCount}/${this._MAX_FAILURES}): ${error.message}`
        )
      }
      if (error.response && error.response.data) {
        return { success: false, error: error.response.data.detail || error.message }
      }
      return { success: false, error: error.message }
    }
  }

  getPoolStatus() {
    return {
      status: this.isReady ? 'ONLINE' : 'OFFLINE',
      circuit: this._circuitOpen ? 'OPEN' : 'CLOSED',
      type: 'FastAPI_Microservice',
      url: FASTAPI_URL,
    }
  }

  restartPool() {
    this._circuitOpen = false
    this._failCount = 0
    logger.info('[PythonService] Circuit reset')
  }

  async waitForReady(timeoutMs = 60000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const isUp = await this.checkHealth()
      if (isUp) return true
      await new Promise((r) => setTimeout(r, 1000))
    }
    logger.warn('[PythonService] Timeout waiting for FastAPI')
    return false
  }
}

module.exports = new PythonService()
