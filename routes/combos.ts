import express, { Request, Response } from 'express'
const router = express.Router()
import comboService from '../services/comboService'

router.get('/', async (_req: Request, res: Response) => {
  try {
    const todayCombos = await comboService.getTodayCombos()
    res.json(todayCombos)
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message })
  }
})

router.get('/today', async (_req: Request, res: Response) => {
  try {
    const todayCombos = await comboService.getTodayCombos()
    res.json({
      date: new Date().toISOString().split('T')[0],
      combos: todayCombos,
    })
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message })
  }
})

router.post('/generate', async (_req: Request, res: Response) => {
  try {
    const newCombos = await comboService.refreshCombos()
    res.json({
      success: true,
      message: 'Combo generation triggered.',
      generatedCount: newCombos.length,
    })
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message })
  }
})

router.get('/history', async (_req: Request, res: Response) => {
  try {
    const history = await comboService.loadHistory()
    res.json(history)
  } catch (error: unknown) {
    res.status(500).json({ error: (error as Error).message })
  }
})

export = router
