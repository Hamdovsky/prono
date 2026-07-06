const express = require('express')
const router = express.Router()
const { detectHotGrids, getGridRecommendations } = require('../services/gridHotDetector')

// GET /api/grids/hot - Détecter les grids à fort potentiel
router.get('/hot', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const minScore = parseFloat(req.query.minScore) || 50
    
    const result = detectHotGrids({ limit, minScore })
    
    res.json({
      success: true,
      ...result
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    })
  }
})

// GET /api/grids/recommendations - Recommandations de grids
router.get('/recommendations', (req, res) => {
  try {
    const result = getGridRecommendations()
    
    res.json({
      success: true,
      ...result
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    })
  }
})

module.exports = router