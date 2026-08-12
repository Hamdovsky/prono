const mockDbState = {
  bets: [],
  matches: [],
  historical: [],
}

jest.mock('../core/database', () => ({
  prepare: (sql) => {
    const q = sql.replace(/\s+/g, ' ').trim()
    if (q.startsWith('SELECT id FROM bets')) {
      return {
        get: (label, pick) =>
          mockDbState.bets.find((b) => b.match_label === label && b.pick === pick) || undefined,
      }
    }
    if (q.includes('FROM historical_matches')) {
      return { all: () => mockDbState.historical }
    }
    if (q.includes('FROM matches')) {
      return { all: () => mockDbState.matches }
    }
    if (q.startsWith('INSERT INTO bets')) {
      return {
        run: (...args) => {
          mockDbState.bets.push({
            match_label: args[0],
            league: args[1],
            pick: args[2],
            odds: args[3],
            stake: args[4],
            result: args[5],
            profit: args[6],
            note: args[7],
            date: args[8],
          })
        },
      }
    }
    return { all: () => [], get: () => undefined, run: () => {} }
  },
}))

jest.mock('../core/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../core/confidenceScorer', () => ({ recordSettlement: jest.fn() }))
jest.mock('../core/accuracyStore', () => ({
  appendResult: jest.fn(),
  removeResult: jest.fn(),
}))

const settlementService = require('../services/settlementService')

beforeEach(() => {
  mockDbState.bets = []
  mockDbState.matches = []
  mockDbState.historical = []
})

describe('buildBetRecord', () => {
  test('builds a won bet with odds, profit, note and date', () => {
    const row = {
      homeTeam: 'OM',
      awayTeam: 'PSG',
      league: 'Ligue 1',
      odds_home: 1.85,
      startTimestamp: '2026-08-12T18:00:00Z',
    }
    const record = settlementService.buildBetRecord(row, '1', 'WON', 2, 1)
    expect(record).toEqual({
      match_label: 'OM vs PSG',
      league: 'Ligue 1',
      pick: '1',
      odds: 1.85,
      stake: 1,
      result: 'won',
      profit: 0.85,
      note: '2-1',
      date: '2026-08-12',
    })
  })

  test('falls back to odds 2.0 with profit -1 for a lost pick without odds', () => {
    const row = { homeTeam: 'Real', awayTeam: 'Bar', league: '', startTimestamp: 0 }
    const record = settlementService.buildBetRecord(row, 'OVER 2.5', 'LOST', 1, 3)
    expect(record.odds).toBe(2)
    expect(record.result).toBe('lost')
    expect(record.profit).toBe(-1)
    expect(record.note).toBe('1-3')
  })

  test('returns null when there is no pick', () => {
    const record = settlementService.buildBetRecord(
      { homeTeam: 'A', awayTeam: 'B' },
      null,
      'WON',
      1,
      0
    )
    expect(record).toBeNull()
  })

  test('is idempotent: same match+pick is not duplicated', () => {
    const row = { homeTeam: 'OM', awayTeam: 'PSG', odds_home: 1.85, startTimestamp: 0 }
    expect(settlementService.buildBetRecord(row, '1', 'WON', 2, 1)).not.toBeNull()
    mockDbState.bets.push({ match_label: 'OM vs PSG', pick: '1' })
    expect(settlementService.buildBetRecord(row, '1', 'WON', 2, 1)).toBeNull()
  })
})

describe('backfillBets', () => {
  test('inserts settled matches from the matches table', async () => {
    mockDbState.matches = [
      {
        id: 'm1',
        homeTeam: 'OM',
        awayTeam: 'PSG',
        scoreHome: 2,
        scoreAway: 1,
        league: 'Ligue 1',
        prediction: '1',
        result: 'WON',
        fullData: '{"quant":{"main_pick":"1"}}',
        startTimestamp: 1752945600000,
        odds_home: 1.85,
        settled_at: 1753000000000,
      },
    ]
    const summary = await settlementService.backfillBets({ dryRun: false, limit: 100 })
    expect(summary.inserted).toBe(1)
    expect(mockDbState.bets).toHaveLength(1)
    expect(mockDbState.bets[0]).toMatchObject({
      pick: '1',
      result: 'won',
      profit: 0.85,
      stake: 1,
      note: '2-1',
    })
  })

  test('is idempotent when run twice', async () => {
    mockDbState.matches = [
      {
        id: 'm1',
        homeTeam: 'A',
        awayTeam: 'B',
        scoreHome: 1,
        scoreAway: 0,
        result: 'WON',
        prediction: '1',
        fullData: '{}',
      },
    ]
    await settlementService.backfillBets({ limit: 100 })
    expect(mockDbState.bets).toHaveLength(1)

    const second = await settlementService.backfillBets({ limit: 100 })
    expect(second.inserted).toBe(0)
    expect(second.alreadyPresent).toBe(1)
    expect(mockDbState.bets).toHaveLength(1)
  })

  test('dry-run writes nothing but reports wouldInsert', async () => {
    mockDbState.matches = [
      {
        id: 'm1',
        homeTeam: 'A',
        awayTeam: 'B',
        scoreHome: 1,
        scoreAway: 0,
        result: 'WON',
        prediction: '1',
        fullData: '{}',
      },
    ]
    const summary = await settlementService.backfillBets({ dryRun: true, limit: 100 })
    expect(summary.wouldInsert).toBe(1)
    expect(summary.inserted).toBe(0)
    expect(mockDbState.bets).toHaveLength(0)
  })

  test('backfills archived historical matches using settlement logic', async () => {
    mockDbState.historical = [
      {
        id: 'h1',
        homeTeam: 'Lyon',
        awayTeam: 'Nice',
        scoreHome: 0,
        scoreAway: 2,
        league: 'Ligue 1',
        fullData: '{"quant":{"main_pick":"2"}}',
        timestamp: '2026-08-12T18:00:00Z',
      },
    ]
    const summary = await settlementService.backfillBets({ limit: 100 })
    expect(summary.inserted).toBe(1)
    expect(mockDbState.bets[0]).toMatchObject({
      match_label: 'Lyon vs Nice',
      pick: '2',
      result: 'won',
      note: '0-2',
      odds: 2,
      profit: 1,
      date: '2026-08-12',
    })
  })

  test('skips archived matches without a real pick', async () => {
    mockDbState.historical = [
      {
        id: 'h1',
        homeTeam: 'A',
        awayTeam: 'B',
        scoreHome: 1,
        scoreAway: 1,
        fullData: '{}',
        timestamp: '2026-08-12T18:00:00Z',
      },
    ]
    const summary = await settlementService.backfillBets({ limit: 100 })
    expect(summary.skipped).toBe(1)
    expect(summary.inserted).toBe(0)
  })
})
