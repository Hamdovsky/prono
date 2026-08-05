import EventEmitter from 'events'
import logger from '../core/logger'

interface ScraperStatus {
  [key: string]: unknown
  timestamp?: number
}

interface MatchUpdateEvent {
  match: Record<string, unknown>
  prevMatch: Record<string, unknown> | null
  timestamp: number
}

class GlobalEventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(100)
    this.on('error', (err: Error) => {
      logger.error(`[EVENT-BUS] Unhandled error: ${err.message}`)
    })
  }

  emitMatchUpdate(
    match: Record<string, unknown>,
    prevMatch: Record<string, unknown> | null = null
  ): void {
    this.emit('match_updated', {
      match,
      prevMatch,
      timestamp: Date.now(),
    } satisfies MatchUpdateEvent)
  }

  emitScraperStatus(status: ScraperStatus): void {
    this.emit('scraper_status', {
      ...status,
      timestamp: Date.now(),
    })
  }
}

const eventBus = new GlobalEventBus()

export = eventBus
