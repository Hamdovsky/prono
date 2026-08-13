// TN-INTEL Logging Service - Production Grade
// Writes are queued and flushed asynchronously in batches to avoid
// blocking the event loop on every hot-path log call.
const fs = require('fs')
const path = require('path')

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, '..', 'logs')
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true })
    }

    this.errorLog = path.join(this.logDir, 'error.log')
    this.infoLog = path.join(this.logDir, 'info.log')
    this.currentDate = new Date().toISOString().split('T')[0]

    // 🛡️ [RECURSION GUARD]
    this.isProcessingError = false
    this.logBurstCount = 0
    this.lastBurstReset = Date.now()
    this.MAX_BURST = 20 // Reduced from 50 to further mitigate IO pressure

    // ── Async write queue ──
    this.queue = []          // entries: { file, line }
    this.queuedBytes = 0
    this.MAX_QUEUE = 5000    // drop when this many lines are pending
    this._flushing = false
    this._flushTimer = setInterval(() => this._flush(), 500)
    this._flushTimer.unref()
  }

  get _rotatedErrorLog() {
    return this.errorLog
  }

  get _rotatedInfoLog() {
    return this.infoLog
  }

  _getTimestamp() {
    return new Date().toISOString()
  }

  _formatMessage(level, message, meta = {}) {
    const safeMeta = {}
    try {
      for (const [key, value] of Object.entries(meta)) {
        if (value instanceof Error) {
          safeMeta[key] = { message: value.message, stack: value.stack }
        } else if (typeof value === 'object' && value !== null) {
          try {
            safeMeta[key] = JSON.stringify(value).substring(0, 500) // Truncate long objects
          } catch (e) {
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
    } catch (e) {
      return `${this._getTimestamp()} [${level}] ${message} (Meta serialization failed)\n`
    }
  }

  _rotateIfNeeded() {
    const today = new Date().toISOString().split('T')[0]
    if (today !== this.currentDate) {
      // Rotate logs
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
      } catch (e) {
        try {
          console.error('Log rotation failed:', e.message)
        } catch (_) {}
      }
      this.currentDate = today

      // Cleanup logs older than 14 days
      this._cleanupOldLogs()
    }
  }

  _cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir)
      const now = Date.now()
      const maxAge = 14 * 24 * 60 * 60 * 1000 // 14 days

      files.forEach((file) => {
        const filePath = path.join(this.logDir, file)
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath)
        }
      })
    } catch (e) {}
  }

  _enqueue(file, line) {
    // Drop under memory pressure instead of blocking the event loop.
    if (this.queue.length >= this.MAX_QUEUE) {
      if (this.itemsDropped === undefined) this.itemsDropped = 0
      this.itemsDropped++
      return
    }
    this.queue.push({ file, line })
    this.queuedBytes += line.length

    // Flush eagerly on very large batches to bound memory.
    if (this.queue.length >= 2000 || this.queuedBytes >= 4 * 1024 * 1024) {
      this._flush()
    }
  }

  async _flush() {
    if (this._flushing || this.queue.length === 0) return
    this._flushing = true
    const batch = this.queue
    this.queue = []
    this.queuedBytes = 0

    try {
      // Append lines sequentially per file path, asynchronously.
      const grouped = new Map()
      for (const { file, line } of batch) {
        if (!grouped.has(file)) grouped.set(file, [])
        grouped.get(file).push(line)
      }
      await Promise.all(
        Array.from(grouped, ([file, lines]) => fs.promises.appendFile(file, lines.join('')))
      )
    } catch (e) {
      // Ephemeral FS errors must never crash the app; retry once in background.
      try {
        if (batch.length > 0) {
          const first = batch[0]
          fs.promises.appendFile(first.file, batch.map((e) => e.line).join('')).catch(() => {})
        }
      } catch (_) {}
    } finally {
      this._flushing = false
    }
  }

  info(message, meta = {}) {
    try {
      this._rotateIfNeeded()
      const formatted = this._formatMessage('INFO', message, meta)
      this._enqueue(this.infoLog, formatted)
      console.log(`ℹ️  ${message}`, meta)
    } catch (e) {
      // Silently handle EPIPE/FS errors
    }
  }

  warn(message, meta = {}) {
    try {
      this._rotateIfNeeded()
      const formatted = this._formatMessage('WARN', message, meta)
      this._enqueue(this.infoLog, formatted)
      console.warn(`⚠️  ${message}`, meta)
    } catch (e) {
      // Silently handle EPIPE/FS errors
    }
  }

  debug(message, meta = {}) {
    if (process.env.NODE_ENV === 'development' || process.env.DEBUG) {
      try {
        console.debug(`🐞 ${message}`, meta)
      } catch (e) {}
    }
  }

  error(message, error = null, meta = {}) {
    if (this.isProcessingError) return // Prevent recursive log storm

    try {
      this.isProcessingError = true
      this._rotateIfNeeded()

      // 🛡️ [BURST PROTECTION]
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

      const errorDetails = error
        ? {
            message: error.message,
            stack: error.stack,
            ...meta,
          }
        : meta

      const formatted = this._formatMessage('ERROR', message, errorDetails)

      // 🛡️ [SIZE PROTECTION] Don't write to disk if log is already massive (>50MB)
      let skipFile = false
      try {
        if (fs.existsSync(this.errorLog) && fs.statSync(this.errorLog).size > 50 * 1024 * 1024) {
          skipFile = true
        }
      } catch (e) {}

      if (!skipFile) {
        this._enqueue(this.errorLog, formatted)
      }

      // 🛡️ [EPIPE PROTECTION] Handle broken stdout/stderr gracefully
      try {
        process.stderr.write(`❌ ${message} ${JSON.stringify(errorDetails)}\n`)
      } catch (epipe) {}
    } catch (fatalErr) {
    } finally {
      this.isProcessingError = false
    }
  }

  // Flush pending writes synchronously (used on graceful shutdown).
  flushSync() {
    try {
      if (this.queue.length === 0) return
      const batch = this.queue
      this.queue = []
      this.queuedBytes = 0
      const grouped = new Map()
      for (const { file, line } of batch) {
        if (!grouped.has(file)) grouped.set(file, [])
        grouped.get(file).push(line)
      }
      for (const [file, lines] of grouped) {
        fs.appendFileSync(file, lines.join(''))
      }
    } catch (e) {}
  }
}

const logger = new Logger()

// NOTE: uncaughtException/unhandledRejection handlers are in server.js
// (only one handler can be active — Node keeps the last one registered)

// Flush remaining queue on process exit (best-effort, sync).
process.on('exit', () => {
  try {
    logger.flushSync()
  } catch (_) {}
})

module.exports = logger
