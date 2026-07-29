import fs from 'fs'
import path from 'path'

interface LogMeta {
  [key: string]: unknown
  message?: string
  stack?: string
}

class Logger {
  private logDir: string
  private errorLog: string
  private infoLog: string
  private currentDate: string
  private isProcessingError: boolean = false
  private logBurstCount: number = 0
  private lastBurstReset: number = Date.now()
  private readonly MAX_BURST: number = 20

  constructor() {
    this.logDir = path.join(__dirname, '..', 'logs')
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }

    this.errorLog = path.join(this.logDir, 'error.log')
    this.infoLog = path.join(this.logDir, 'info.log')
    this.currentDate = new Date().toISOString().split('T')[0]
  }

  private _getTimestamp(): string {
    return new Date().toISOString()
  }

  private _formatMessage(level: string, message: string, meta: LogMeta = {}): string {
    const safeMeta: LogMeta = {}
    try {
      for (const [key, value] of Object.entries(meta)) {
        if (value instanceof Error) {
          safeMeta[key] = { message: value.message, stack: value.stack }
        } else if (typeof value === 'object' && value !== null) {
          try {
            safeMeta[key] = JSON.stringify(value).substring(0, 500)
          } catch (_e) {
            safeMeta[key] = '[Object]'
          }
        } else {
          safeMeta[key] = value
        }
      }
      return (
        JSON.stringify({
          timestamp: this._getTimestamp(),
          level,
          message,
          ...safeMeta,
        }) + '\n'
      )
    } catch (_e) {
      return `${this._getTimestamp()} [${level}] ${message} (Meta serialization failed)\n`
    }
  }

  private _rotateIfNeeded(): void {
    const today = new Date().toISOString().split('T')[0]
    if (today !== this.currentDate) {
      const archiveDate = this.currentDate
      try {
        if (fs.existsSync(this.errorLog)) {
          const errorArchive = path.join(this.logDir, `error_${archiveDate}.log`)
          fs.renameSync(this.errorLog, errorArchive)
        }
        if (fs.existsSync(this.infoLog)) {
          const infoArchive = path.join(this.logDir, `info_${archiveDate}.log`)
          fs.renameSync(this.infoLog, infoArchive)
        }
      } catch (_e) {
        try {
          console.error('Log rotation failed')
        } catch (_) {}
      }
      this.currentDate = today
      this._cleanupOldLogs()
    }
  }

  private _cleanupOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir)
      const now = Date.now()
      const maxAge = 14 * 24 * 60 * 60 * 1000

      files.forEach((file) => {
        const filePath = path.join(this.logDir, file)
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath)
        }
      })
    } catch (_e) {}
  }

  info(message: string, meta: LogMeta = {}): void {
    try {
      this._rotateIfNeeded()
      const formatted = this._formatMessage('INFO', message, meta)
      fs.appendFileSync(this.infoLog, formatted)
      console.log(`ℹ️  ${message}`, meta)
    } catch (_e) {}
  }

  warn(message: string, meta: LogMeta = {}): void {
    try {
      this._rotateIfNeeded()
      const formatted = this._formatMessage('WARN', message, meta)
      fs.appendFileSync(this.infoLog, formatted)
      console.warn(`⚠️  ${message}`, meta)
    } catch (_e) {}
  }

  debug(message: string, meta: LogMeta = {}): void {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
      try {
        console.debug(`🐞 ${message}`, meta)
      } catch (_e) {}
    }
  }

  error(message: string, error: Error | null = null, meta: LogMeta = {}): void {
    if (this.isProcessingError) return

    try {
      this.isProcessingError = true
      this._rotateIfNeeded()

      const now = Date.now()
      if (now - this.lastBurstReset > 10000) {
        this.logBurstCount = 0
        this.lastBurstReset = now
      }
      this.logBurstCount++
      if (this.logBurstCount > this.MAX_BURST) {
        if (this.logBurstCount === this.MAX_BURST + 1) {
          try {
            console.error('🔥 [LOGGER] Error burst detected! Throttling disk writes...')
          } catch (_) {}
        }
        return
      }

      const errorDetails: LogMeta = error
        ? {
            message: error.message,
            stack: error.stack,
            ...meta,
          }
        : meta

      const formatted = this._formatMessage('ERROR', message, errorDetails)

      let skipFile = false
      try {
        if (fs.existsSync(this.errorLog) && fs.statSync(this.errorLog).size > 50 * 1024 * 1024) {
          skipFile = true
        }
      } catch (_e) {}

      if (!skipFile) {
        try {
          fs.appendFileSync(this.errorLog, formatted)
        } catch (_fsErr) {}
      }

      try {
        process.stderr.write(`❌ ${message} ${JSON.stringify(errorDetails)}\n`)
      } catch (_epipe) {}
    } catch (_fatalErr) {
    } finally {
      this.isProcessingError = false
    }
  }
}

const logger = new Logger()

export = logger
