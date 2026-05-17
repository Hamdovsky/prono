const express = require('express');
const router = express.Router();
const comboService = require('../services/comboService');

/**
 * GET /api/combos
 * Returns today's combinations (Flat array for dataService)
 */
router.get('/', async (req, res) => {
    try {
        const todayCombos = await comboService.getTodayCombos();
        res.json(todayCombos); 
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/combos/today
 * Returns today's match combinations.
 */
router.get('/today', async (req, res) => {
    try {
        const todayCombos = await comboService.getTodayCombos();
        res.json({ 
            date: new Date().toISOString().split('T')[0], 
            combos: todayCombos 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/combos/generate
 * Triggers manual combo generation.
 */
router.post('/generate', async (req, res) => {
    try {
        const newCombos = await comboService.refreshCombos();
        res.json({ 
            success: true, 
            message: 'Combo generation triggered.',
            generatedCount: newCombos.length 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/combos/history
 * Returns full combo history.
 */
router.get('/history', async (req, res) => {
    try {
        const history = await comboService.loadHistory();
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
