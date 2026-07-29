/* eslint-disable */

// Express extensions
declare namespace Express {
  interface Request {
    ip?: string
    originalUrl: string
    route?: {
      stack: { handle?: import('express').RequestHandler }[]
    }
  }
}

// Core modules
declare module 'core/database' {
  import database from '../core/database'
  export = database
}

declare module 'core/logger' {
  import logger from '../core/logger'
  export = logger
}

declare module 'core/configEngine' {
  import configEngine from '../core/configEngine'
  export = configEngine
}

declare module 'core/speedCache' {
  export function speedCache(key: string, ttlMs?: number, staleMs?: number): import('express').RequestHandler
  export function invalidateCache(keyPrefix: string): void
}

declare module 'core/networkConfig' {
  export const httpAgent: import('http').Agent
  export const httpsAgent: import('https').Agent
  export function getUndiciAgent(): null
  export function getAgent(url?: string): import('http').Agent | import('https').Agent
  export const pooledConfig: {
    httpAgent: import('http').Agent
    httpsAgent: import('https').Agent
    timeout: number
    maxSockets: number
    maxFreeSockets: number
    retries: number
    retryDelay: number
    keepAlive: boolean
    scheduling: string
  }
}

declare module 'core/deterministic' {
  class SeededRandom {
    constructor(seed: string | number)
    next(): number
    range(min: number, max: number): number
    floor(min: number, max: number): number
  }
  export = SeededRandom
}

declare module 'core/confidenceScorer' {
  const confidenceScorer: {
    score(match: Record<string, unknown>, prediction: Record<string, unknown>): Promise<number>
  }
  export = confidenceScorer
}

declare module 'core/enriched_predictions' {
  const enrichedPredictions: {
    enrich(match: Record<string, unknown>, prediction: Record<string, unknown>): Promise<Record<string, unknown>>
    enrichMatches(matches: Record<string, unknown>[], opts?: Record<string, unknown>): Promise<Record<string, unknown>[]>
  }
  export = enrichedPredictions
}

declare module 'core/pg_connector' {
  export function query(sql: string, params?: unknown[]): Promise<unknown[]>
  export function usingPostgres(): boolean
  export function getPool(): unknown
}

declare module 'core/sharedConfig' {
  const config: Record<string, unknown>
  export = config
}

declare module 'core/pythonService' {
  const pythonService: {
    call(method: string, params?: unknown): Promise<unknown>
    isAvailable(): boolean
  }
  export = pythonService
}

declare module 'core/telegramBot' {
  const bot: {
    sendMessage(chatId: string | number, message: string): Promise<unknown>
    sendAlert(message: string): Promise<unknown>
  }
  export = bot
}

declare module 'core/metrics' {
  export const httpRequestsTotal: import('prom-client').Counter<string>
  export const activeConnections: import('prom-client').Gauge<string>
  export const circuitBreakerState: import('prom-client').Gauge<string>
  export const cacheHits: import('prom-client').Counter<string>
  export const cacheMisses: import('prom-client').Counter<string>
  export const register: import('prom-client').Registry
}

declare module 'core/matchSanitizer' {
  export function sanitizeMatches(matches: Record<string, unknown>[]): Record<string, unknown>[]
}
