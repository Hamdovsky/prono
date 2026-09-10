const express = require('express')
const router = express.Router()
const authService = require('../services/authService')
const logger = require('../core/logger')

async function userCount() {
  const database = authService.getDb()
  const rawDb = database.db || database
  const row = await rawDb.prepare('SELECT COUNT(*) AS n FROM users').get()
  return Number(row?.n ?? 0)
}

// É10 : register était ouvert — un visiteur pourrait créer un compte et, une
// fois le rôle 'user' accepté quelque part, toucher aux données privées.
// Règle : premier compte = owner/admin (bootstrap, doit être Hamdi), tout
// compte supplémentaire exige le token admin d'API.
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }
    const bootstrap = (await userCount()) === 0
    if (!bootstrap) {
      const secret = process.env.API_SECRET_KEY
      const h = req.headers.authorization || ''
      if (!secret || !h.startsWith('Bearer ') || h.slice(7) !== secret) {
        return res.status(401).json({ error: 'Registration requires admin token' })
      }
    }
    const result = await authService.register(username, email, password, bootstrap ? 'admin' : 'user')
    res.json({ success: true, ...result })
  } catch (e) {
    logger.warn(`[AUTH] Register failed: ${e.message}`)
    res.status(400).json({ error: e.message })
  }
})

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    const result = await authService.login(username, password)
    res.json({ success: true, ...result })
  } catch (e) {
    logger.warn(`[AUTH] Login failed: ${e.message}`)
    res.status(401).json({ error: e.message })
  }
})

router.get('/me', authService.authenticate.bind(authService), (req, res) => {
  res.json({ success: true, user: req.user })
})

module.exports = router
