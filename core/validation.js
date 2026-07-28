const { z } = require('zod')

const MatchSchema = z.object({
  homeTeam: z.string().min(1, 'homeTeam is required'),
  awayTeam: z.string().min(1, 'awayTeam is required'),
  league: z.string().optional(),
  startTimestamp: z.number().optional(),
  odds_home: z.number().positive().optional(),
  odds_draw: z.number().positive().optional(),
  odds_away: z.number().positive().optional(),
})

const LearnSchema = z.object({
  matchId: z.string().min(1),
  result: z.enum(['H', 'D', 'A']),
  scoreHome: z.number().int().min(0).optional(),
  scoreAway: z.number().int().min(0).optional(),
})

const LearnBatchSchema = z.object({
  results: z.array(LearnSchema).min(1).max(100),
})

const ConfigSchema = z.object({
  scraperUrl: z.string().url().optional(),
  SOURCE_MODE: z.enum(['auto', 'manual', 'bsd_only']).optional(),
  thresholds: z.record(z.number()).optional(),
  autoPurge: z.boolean().optional(),
  strategy: z.string().optional(),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
})

const BackfillSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  scoreHome: z.number().int().min(0),
  scoreAway: z.number().int().min(0),
  league: z.string().optional(),
  startTimestamp: z.number().optional(),
})

const EloUpdateSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  scoreHome: z.number().int().min(0),
  scoreAway: z.number().int().min(0),
})

const ScrapeTriggerSchema = z.object({
  url: z.string().url(),
  type: z.string().optional(),
})

const SeedMatchSchema = z.object({
  homeTeam: z.string().min(1),
  awayTeam: z.string().min(1),
  league: z.string().optional(),
  startTimestamp: z.number().optional(),
  odds_home: z.number().positive().optional(),
  odds_draw: z.number().positive().optional(),
  odds_away: z.number().positive().optional(),
})

const ScraperToggleSchema = z.object({
  mode: z.enum(['firecrawl_primary', 'jina_primary']),
})

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const errors = result.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      }))
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors,
      })
    }
    req.validatedBody = result.data
    next()
  }
}

module.exports = {
  validate,
  MatchSchema,
  LearnSchema,
  LearnBatchSchema,
  ConfigSchema,
  BackfillSchema,
  EloUpdateSchema,
  ScrapeTriggerSchema,
  SeedMatchSchema,
  ScraperToggleSchema,
}
