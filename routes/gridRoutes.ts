import express, { Request, Response } from 'express'
const router = express.Router()
import { detectHotGrids, getGridRecommendations } from '../services/gridHotDetector'

router.get('/hot', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10
    const minScore = parseFloat(req.query.minScore as string) || 50
    const result = detectHotGrids({ limit, minScore })
    res.json({ success: true, ...result })
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message })
  }
})

router.get('/recommendations', (_req: Request, res: Response) => {
  try {
    const result = getGridRecommendations()
    res.json({ success: true, ...result })
  } catch (e: unknown) {
    res.status(500).json({ success: false, error: (e as Error).message })
  }
})

export = router
