import express, { Request, Response } from 'express'
const router = express.Router()
import authService from '../services/authService'
import logger from '../core/logger'

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body as { username?: string; email?: string; password?: string }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }
    const result = await authService.register(username, email, password)
    res.json({ success: true, ...result })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`[AUTH] Register failed: ${msg}`)
    res.status(400).json({ error: msg })
  }
})

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    const result = await authService.login(username, password)
    res.json({ success: true, ...result })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.warn(`[AUTH] Login failed: ${msg}`)
    res.status(401).json({ error: msg })
  }
})

router.get('/me', authService.authenticate.bind(authService), (req: Request, res: Response) => {
  res.json({ success: true, user: (req as unknown as { user?: unknown }).user })
})

export = router
