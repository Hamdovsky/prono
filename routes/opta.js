/**
 * routes/opta.js — endpoint de la source theAnalyst (Opta 1X2) (E69).
 * Données de PROBABILITÉ (pourcentages), pas des cotes bookmaker : n'alimente
 * pas le pipeline odds. Voir services/theAnalystClient.js + optaPredictions.js.
 */
const express = require('express')
const router = express.Router()
const database = require('../core/database')
const store = require('../services/optaPredictions')
const { localOrAuth } = require('../core/authGuards')

/** GET /api/opta/predictions — prédictions Opta stockées (option ?league=&limit=) */
router.get('/opta/predictions', (req, res) => {
  try {
    const league = req.query.league ? String(req.query.league) : undefined
    const limit = req.query.limit ? Number(req.query.limit) : 50
    const rows = store.listPredictions(database, { league, limit })
    res.json({ success: true, count: rows.length, predictions: rows })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** GET /api/opta/status — état de la source (couverture + santé) */
router.get('/opta/status', (req, res) => {
  try {
    res.json({ success: true, enabled: store.getStats(database).client.enabled, ...store.getStats(database) })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

/** POST /api/opta/sync — déclenche une passe (default dry-run, ?write=1 en écriture) */
router.post('/opta/sync', localOrAuth, async (req, res) => {
  try {
    const write = req.query.write === '1' || req.query.write === 'true'
    const stats = await store.sync(database, { write, maxLeagues: req.query.leagues ? Number(req.query.leagues) : undefined })
    res.json({ success: true, ...stats })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
