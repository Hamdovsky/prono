import express, { Request, Response } from 'express'
const router = express.Router()
import logger from '../core/logger'
import database from '../core/database'
import valueBetEnricher from '../services/valueBetEnricher'

interface ValueBetResult {
  id: string
  date: string
  homeTeam: string
  awayTeam: string
  league: string
  kickoff: string
  outcome: string
  marketOdds: number
  fairOdds: number
  valuePercent: number
  confidence: number
  homeXG: number
  awayXG: number
  adjustments: unknown
}

router.get('/value-bets', async (req: Request, res: Response) => {
  try {
    const dateStr = (req.query.date as string) || new Date().toISOString().split('T')[0]
    const minValue = parseFloat(req.query.minValue as string) || 5
    const leagueFilter = req.query.league as string | null

    const matches = await database.getMatchesByDate(dateStr)
    if (!matches || matches.length === 0) {
      return res.json({ success: true, date: dateStr, total: 0, valueBets: [] })
    }

    let filtered = matches
    if (leagueFilter) {
      filtered = matches.filter(
        (m: Record<string, unknown>) =>
          ((m.league as string) || '').toLowerCase() === leagueFilter.toLowerCase() ||
          ((m.competition as string) || '').toLowerCase() === leagueFilter.toLowerCase()
      )
    }

    const results: ValueBetResult[] = []
    for (const match of filtered) {
      const enriched = await valueBetEnricher.enrichMatch(match)
      if (enriched && enriched.valueBets && enriched.valueBets.length > 0) {
        for (const vb of enriched.valueBets) {
          if (vb.valuePct >= minValue) {
            results.push({
              id: match.id,
              date: dateStr,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
              league: match.league || match.competition,
              kickoff: match.timestamp || match.date,
              outcome: vb.outcome,
              marketOdds: vb.marketOdds,
              fairOdds: vb.fairOdds,
              valuePercent: vb.valuePct,
              confidence: enriched.confidence,
              homeXG: enriched.homeXG,
              awayXG: enriched.awayXG,
              adjustments: enriched.adjustmentFactors,
            })
          }
        }
      }
    }

    results.sort((a, b) => b.valuePercent - a.valuePercent)

    res.json({
      success: true,
      date: dateStr,
      total: results.length,
      valueBets: results.slice(0, 50),
    })
  } catch (e: unknown) {
    logger.error(`[VALUE-BETS] Error: ${(e as Error).message}`)
    res.status(500).json({ success: false, error: (e as Error).message })
  }
})

router.get('/value-bets/enrich/:matchId', async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params
    const dateStr = new Date().toISOString().split('T')[0]
    const matches = await database.getMatchesByDate(dateStr)
    const match = matches.find((m: Record<string, unknown>) => String(m.id) === String(matchId))

    if (!match) {
      return res.status(404).json({ success: false, error: 'Match not found' })
    }

    const enriched = await valueBetEnricher.enrichMatch(match)
    res.json({ success: true, match: enriched })
  } catch (e: unknown) {
    logger.error(`[VALUE-BETS] Enrich error: ${(e as Error).message}`)
    res.status(500).json({ success: false, error: (e as Error).message })
  }
})

export = router
