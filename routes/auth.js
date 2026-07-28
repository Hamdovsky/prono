const express = require('express')
const router = express.Router()
const authService = require('../services/authService')
const logger = require('../core/logger')

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }
    const result = await authService.register(username, email, password)
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
