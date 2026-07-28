declare module '../core/database' {
  const database: {
    getMatchesByDate(date: string, league?: string): Promise<any[]>
    getMatchById(id: string | number): Promise<any>
    getUpcomingMatches(limit?: number): Promise<any[]>
    getLiveMatches(): Promise<any[]>
    savePrediction(matchId: string | number, prediction: any): Promise<void>
    saveMatch(match: any): Promise<any>
    insertMatch(match: any): Promise<any>
    resolveTeamName(name: string): Promise<string>
    query(sql: string, params?: any[]): Promise<any[]>
    execute(sql: string, params?: any[]): Promise<any>
    getConnection(): any
    db?: any
  }
  export = database
}

declare module '../core/logger' {
  const logger: {
    info(msg: string, ...args: any[]): void
    warn(msg: string, ...args: any[]): void
    error(msg: string, ...args: any[]): void
    debug(msg: string, ...args: any[]): void
  }
  export = logger
}

declare module '../core/enriched_predictions' {
  const enrichedPredictions: {
    enrich(match: any, prediction: any): Promise<any>
    enrichBatch(matches: any[]): Promise<any[]>
  }
  export = enrichedPredictions
}

declare module '../core/speedCache' {
  export function invalidateCache(key?: string): void
  export function invalidateAll(): void
}

declare module '../core/telegramBot' {
  const bot: {
    sendMessage(chatId: string | number, message: string): Promise<any>
    sendAlert(message: string): Promise<any>
  }
  export = bot
}

declare module '../core/sharedConfig' {
  const config: Record<string, any>
  export = config
}

declare module '../core/configEngine' {
  const configEngine: {
    get(key: string): any
    set(key: string, value: any): void
    getAll(): Record<string, any>
  }
  export = configEngine
}

declare module '../core/networkConfig' {
  export function pooledConfig(name: string): any
}

declare module '../core/pg_connector' {
  export function query(sql: string, params?: any[]): Promise<any[]>
  export function usingPostgres(): boolean
}

declare module '../core/utils' {
  export function saveScraperProgress(data: any): Promise<void>
}

declare module '../core/deterministic' {
  class SeededRandom {
    constructor(seed: number)
    next(): number
  }
  export = SeededRandom
}

declare module '../core/fallback_enricher' {
  const fallbackEnricher: any
  export = fallbackEnricher
}

declare module '../core/autoOptimizer' {
  const autoOptimizer: any
  export = autoOptimizer
}

declare module '../core/confidenceScorer' {
  const confidenceScorer: any
  export = confidenceScorer
}

declare module '../core/pythonService' {
  const pythonService: {
    call(method: string, params: any): Promise<any>
  }
  export = pythonService
}

interface QuotaManager {
  isEnabled(): boolean
  getQuotaStatus(): { date: string; used: number; limit: number; remaining: number; isActive: boolean }
  registerMatch(id: string | number): Promise<number>
}
