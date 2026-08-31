const { describe, it, expect, beforeEach } = require('@jest/globals')
const Database = require('better-sqlite3')

const proPlanBankroll = require('../services/proPlanBankroll')

describe('proPlanBankroll', () => {
  let memDb

  beforeEach(() => {
    memDb = new Database(':memory:')
    proPlanBankroll._internal.__setDb(memDb)
    proPlanBankroll._internal.__resetForTest()
  })

  afterEach(() => {
    memDb.close()
    proPlanBankroll._internal.__setDb(null)
  })

  it('initialise la bankroll à 100 DT / TND / objectif 400', () => {
    const st = proPlanBankroll.getState()
    expect(st.bankroll).toBe(100)
    expect(st.currency).toBe('TND')
    expect(st.target).toBe(400)
    expect(st.paused).toBe(false)
  })

  it('paliers : 1% / 2% / 3% / 4% + objectif atteint', () => {
    proPlanBankroll._internal.__setBankroll(80)
    expect(proPlanBankroll.getTier()).toEqual({ label: 'reconstruction', stakePct: 0.01, maxDailyExposure: 0.03 })
    proPlanBankroll._internal.__setBankroll(100)
    expect(proPlanBankroll.getTier().label).toBe('consolidation')
    proPlanBankroll._internal.__setBankroll(160)
    expect(proPlanBankroll.getTier()).toEqual({ label: 'growth', stakePct: 0.03, maxDailyExposure: 0.08 })
    proPlanBankroll._internal.__setBankroll(260)
    expect(proPlanBankroll.getTier()).toEqual({ label: 'accelerator', stakePct: 0.04, maxDailyExposure: 0.10 })
    proPlanBankroll._internal.__setBankroll(400)
    expect(proPlanBankroll.getTier().label).toBe('target_reached')
  })

  it('recommendStake : Quarter-Kelly plafonné au palier', () => {
    const rec = proPlanBankroll.recommendStake(60, 2.0, 100)
    expect(rec.kellyFull).toBeCloseTo(0.2, 5)
    expect(rec.stakePct).toBe(0.02)
    expect(rec.stakeDt).toBe(2.0)
    expect(rec.capped).toBe(true)
    expect(rec.tier).toBe('consolidation')
  })

  it('recommendStake : mode reconstruction à 1% sous 85 DT', () => {
    const rec = proPlanBankroll.recommendStake(60, 2.0, 80)
    expect(rec.stakePct).toBe(0.01)
    expect(rec.stakeDt).toBe(0.8)
  })

  it('recommendStake : aucune mise si odds <= 1 ou proba hors bornes', () => {
    expect(proPlanBankroll.recommendStake(60, 1.0, 100).stakeDt).toBe(0)
    expect(proPlanBankroll.recommendStake(30, 2.0, 100).stakeDt).toBe(0)
    expect(proPlanBankroll.recommendStake(60, 2.0, 400).stakeDt).toBe(0)
  })

  it('settleBet WON : mise 2 DT (p=60, o=2.0) → +2 DT', () => {
    const out = proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'WON' })
    expect(out.stakeDt).toBe(2)
    expect(out.pnl).toBe(2)
    expect(out.bankroll).toBe(102)
    expect(out.targetReached).toBe(false)
  })

  it('settleBet LOST : −2 DT', () => {
    const out = proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'LOST' })
    expect(out.pnl).toBe(-2)
    expect(out.bankroll).toBe(98)
  })

  it('settleBet PUSH : P&L nul', () => {
    const out = proPlanBankroll.settleBet({ pick: 'X', odds: 3.0, prob: 50, result: 'PUSH' })
    expect(out.pnl).toBe(0)
    expect(out.bankroll).toBe(100)
  })

  it('settleBet rejette un résultat invalide', () => {
    expect(() => proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'PUSH' })).not.toThrow()
    expect(() => proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'VOID' })).toThrow()
  })

  it('stop-loss : bankroll <= 80 DT → pause 7 jours', () => {
    proPlanBankroll._internal.__setBankroll(80.5)
    const out = proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'LOST' })
    expect(out.bankroll).toBeLessThanOrEqual(80)
    expect(out.paused).toBe(true)
    expect(out.pausedUntil).toBeTruthy()
    expect(proPlanBankroll.getState().paused).toBe(true)
  })

  it('objectif atteint : bankroll >= 400 → targetReached, plus de mise', () => {
    proPlanBankroll._internal.__setBankroll(399)
    const out = proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'WON' })
    expect(out.bankroll).toBeGreaterThanOrEqual(400)
    expect(out.targetReached).toBe(true)
    const rec = proPlanBankroll.recommendStake(60, 2.0, out.bankroll)
    expect(rec.stakeDt).toBe(0)
  })

  it('getHistory retourne les règlements (triés du plus récent)', () => {
    proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'WON' })
    proPlanBankroll.settleBet({ pick: '2', odds: 3.5, prob: 55, result: 'LOST' })
    const bets = proPlanBankroll.getHistory()
    expect(bets).toHaveLength(2)
    expect(bets[0].result).toBe('LOST')
  })

  it('getSummary expose progression, stats et règles', () => {
    proPlanBankroll.settleBet({ pick: '1', odds: 2.0, prob: 60, result: 'WON' })
    proPlanBankroll.settleBet({ pick: '2', odds: 3.5, prob: 55, result: 'LOST' })
    const s = proPlanBankroll.getSummary()
    expect(s.progression).toBeCloseTo(0, 3)
    expect(s.stats.bets).toBe(2)
    expect(s.stats.wins).toBe(1)
    expect(s.stats.losses).toBe(1)
    expect(s.stats.totalPnl).toBeCloseTo(-0.04, 2)
    expect(s.rules.stopLoss).toContain('80')
    expect(s.rules.targetRule).toContain('400')
  })
})
