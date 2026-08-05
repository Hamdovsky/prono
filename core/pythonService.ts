import axios from 'axios'
import logger from './logger'

const FASTAPI_URL = process.env.INFERENCE_URL || 'http://127.0.0.1:8000'

interface PoolStatus {
  status: string
  circuit: string
  type: string
  url: string
}

interface PredictResponse {
  success: boolean
  error?: string
  [key: string]: unknown
}

class PythonService {
  private isReady: boolean = false
  private _notified: boolean = false
  private _failCount: number = 0
  private _circuitOpen: boolean = false
  private _circuitOpenedAt: number = 0
  private readonly _COOLDOWN_MS: number = 10 * 60 * 1000
  private readonly _MAX_FAILURES: number = 3

  private _openCircuit(): void {
    this._circuitOpen = true
    this._circuitOpenedAt = Date.now()
    logger.warn(`[PythonService] Circuit OPEN — no retries for ${this._COOLDOWN_MS / 1000}s`)
  }

  private _shouldAllow(): boolean {
    if (!this._circuitOpen) return true
    if (Date.now() - this._circuitOpenedAt > this._COOLDOWN_MS) {
      this._circuitOpen = false
      this._failCount = 0
      logger.info('[PythonService] Circuit half-open — retrying...')
      return true
    }
    return false
  }

  async checkHealth(): Promise<boolean> {
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
    } catch (e: unknown) {
      if (!this._notified) {
        logger.info(
          `⏳ [PythonService] FastAPI not reachable at ${FASTAPI_URL} (${(e as Error).message})`
        )
        this._notified = true
      }
      this.isReady = false
      return false
    }
  }

  async predict(matchData: Record<string, unknown>, timeoutMs = 180000): Promise<PredictResponse> {
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
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { detail?: string } }; message?: string }
      this._failCount++
      if (this._failCount >= this._MAX_FAILURES) {
        this._openCircuit()
      } else {
        logger.warn(
          `[PythonService] Error (${this._failCount}/${this._MAX_FAILURES}): ${axiosErr.message}`
        )
      }
      if (axiosErr.response?.data) {
        return {
          success: false,
          error: axiosErr.response.data.detail || axiosErr.message || String(error),
        }
      }
      return { success: false, error: axiosErr.message || String(error) }
    }
  }

  getPoolStatus(): PoolStatus {
    return {
      status: this.isReady ? 'ONLINE' : 'OFFLINE',
      circuit: this._circuitOpen ? 'OPEN' : 'CLOSED',
      type: 'FastAPI_Microservice',
      url: FASTAPI_URL,
    }
  }

  restartPool(): void {
    this._circuitOpen = false
    this._failCount = 0
    logger.info('[PythonService] Circuit reset')
  }

  async waitForReady(timeoutMs = 60000): Promise<boolean> {
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

const pythonService = new PythonService()
export = pythonService
