// @ts-nocheck
import { spawn } from 'child_process'
import path from 'path'
import logger from '../core/logger'

const SCRIPT_PATH = path.join(__dirname, '..', 'core', 'predict_v553.py')
const PYTHON = process.env.PYTHON_PATH || 'python'

class PythonBridgeService {
  constructor() {
    this._ready = false
    this._warming = false
  }

  async predict(match, timeoutMs = 60000) {
    const start = Date.now()
    try {
      const payload = JSON.stringify(match)
      return await new Promise((resolve) => {
        const proc = spawn(PYTHON, ['-u', SCRIPT_PATH], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        })

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (chunk) => {
          stdout += chunk.toString()
        })
        proc.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
        })

        const timer = setTimeout(() => {
          proc.kill()
          resolve({ success: false, error: 'Timeout', fallback: true, elapsed: Date.now() - start })
        }, timeoutMs)

        proc.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            logger.warn(`[PythonBridge] Exit code ${code}: ${stderr.trim()}`)
          }
          try {
            const result = JSON.parse(stdout.trim())
            resolve({ ...result, elapsed: Date.now() - start })
          } catch (e) {
            resolve({
              success: false,
              error: `Parse error: ${e.message}`,
              output: stdout.trim(),
              stderr: stderr.trim(),
              fallback: true,
            })
          }
        })

        proc.stdin.write(payload)
        proc.stdin.end()
      })
    } catch (e) {
      return { success: false, error: e.message, fallback: true }
    }
  }

  isAvailable() {
    return this._ready
  }

  async warmup() {
    if (this._warming) return this._ready
    this._warming = true
    try {
      const result = await this.predict(
        { homeTeam: 'Test', awayTeam: 'Test', league: 'Test' },
        30000
      )
      this._ready = result && result.success !== false
      logger.info(`[PythonBridge] Warmup ${this._ready ? 'OK' : 'FAILED'}`)
      return this._ready
    } catch (e) {
      logger.warn(`[PythonBridge] Warmup error: ${e.message}`)
      this._ready = false
      return false
    } finally {
      this._warming = false
    }
  }
}

export = new PythonBridgeService()
