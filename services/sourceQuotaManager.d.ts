// @ts-nocheck
export interface QuotaManager {
  isEnabled(): boolean
  getQuotaStatus(): { date: string; used: number; limit: number; remaining: number; isActive: boolean }
  registerMatch(id: string | number): Promise<number>
}

export function createQuotaManager(source: string): QuotaManager
