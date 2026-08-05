import fs from 'fs'
import path from 'path'
import logger from './logger'

interface ConfigData {
  SOURCE_MODE: string
  scraperUrl: string
  thresholds: {
    min_confidence: number
    max_odds: number
    cards: number
    corners: number
    goals: number
  }
  scraper: { timeout: number; retries: number }
  autoPurge: boolean
  strategy: string
  SMART_SCAN_ENABLED: boolean
  WEBHOOK_ENABLED: boolean
  SYNC_PRIORITY: string
  DEEP_NEWS_ENABLED: boolean
  [key: string]: unknown
}

interface StrategyParams {
  probMult: number
  confMult: number
  oddsCap: number
  label: string
}

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json')
const ENV_FILE = path.join(__dirname, '..', '.env')

class ConfigEngine {
  private config: ConfigData

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
      DEEP_NEWS_ENABLED: process.env.DEEP_NEWS_ENABLED !== 'false',
    }
    this.load()
  }

  load(): void {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
        this.config = { ...this.config, ...saved }
        logger.info('⚙️  [CONFIG] Persistent configuration loaded')
      } catch (e) {
        logger.error('❌ [CONFIG] Failed to load config.json', e as Error)
      }
    }
  }

  async save(): Promise<boolean> {
    try {
      await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2))
      logger.info('💾 [CONFIG] Configuration saved to disk')
      return true
    } catch (e) {
      logger.error('❌ [CONFIG] Failed to save config.json', e as Error)
      return false
    }
  }

  async updateEnv(key: string, value: string): Promise<boolean> {
    try {
      let envContent = ''
      if (fs.existsSync(ENV_FILE)) {
        envContent = await fs.promises.readFile(ENV_FILE, 'utf8')
      }

      const lines = envContent.split('\n')
      let found = false
      const newLines = lines.map((line) => {
        if (line.trim().startsWith(`${key}=`)) {
          found = true
          return `${key}=${value}`
        }
        return line
      })

      if (!found) {
        newLines.push(`${key}=${value}`)
      }

      await fs.promises.writeFile(ENV_FILE, newLines.join('\n'))
      process.env[key] = value
      logger.info(`📝 [CONFIG] Updated .env: ${key}`)
      return true
    } catch (e) {
      logger.error(`❌ [CONFIG] Failed to update .env: ${key}`, e as Error)
      return false
    }
  }

  get(key: string, defaultValue?: unknown): unknown {
    const val = this.config[key]
    return val !== undefined ? val : defaultValue
  }

  getStrategyParams(): StrategyParams {
    const strategy = this.config.strategy || 'Balanced'
    switch (strategy) {
      case 'Defensive':
        return { probMult: 1.1, confMult: 1.1, oddsCap: 5.0, label: '🛡️ DEFENSIVE' }
      case 'Aggressive':
        return { probMult: 0.85, confMult: 0.85, oddsCap: 50.0, label: '🚀 AGGRESSIVE' }
      case 'Balanced':
      default:
        return { probMult: 1.0, confMult: 1.0, oddsCap: 15.0, label: '⚖️ BALANCED' }
    }
  }

  set(key: string, value: unknown): Promise<boolean> {
    this.config[key] = value as never
    return this.save()
  }
}

const configEngine = new ConfigEngine()
export = configEngine
