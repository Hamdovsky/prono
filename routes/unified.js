const express = require('express')
const router = express.Router()
const logger = require('../core/logger')
const database = require('../core/database')
const UnifiedEngine = require('../services/unifiedEngine')

/**
 * GET /api/unified/verdicts
 * Unified match verdicts for today's matches
 */
router.get('/verdicts', async (req, res) => {
  try {
    const dateStr = req.query.date || new Date().toISOString().split('T')[0]
    const matches = await database.getMatchesByDate(dateStr)
    const enriched = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])

    const allMatches = matches.length > 0 ? matches : enriched
    if (!allMatches || allMatches.length === 0) {
      return res.json({ success: true, date: dateStr, total: 0, verdicts: [] })
    }

    const sheet = UnifiedEngine.buildDailySheet(allMatches)

    res.json({
      success: true,
      date: dateStr,
      total: sheet.total,
      summary: sheet.summary,
      highlights: sheet.highlights,
      verdicts: req.query.detail !== '0' ? sheet.verdicts : [],
    })
  } catch (e) {
    logger.error(`[UNIFIED] Verdicts error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

/**
 * GET /api/unified/daily-sheet
 * HTML daily betting sheet
 */
router.get('/daily-sheet', async (req, res) => {
  try {
    const matches = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
    const sheet = UnifiedEngine.buildDailySheet(matches)
    const date = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })

    let rows = ''
    for (const v of sheet.verdicts) {
      const valBadge =
        v.value && v.value.ev > 2
          ? `<span style="background:#00c853;color:#000;padding:2px 6px;border-radius:4px;font-size:11px">EV+${v.value.ev}%</span>`
          : ''
      const trapBadge = v.trap
        ? `<span style="background:#ff1744;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px">PIEGE</span>`
        : ''
      const kellyInfo = v.kelly > 0 ? ` | Kelly: ${v.kelly}%` : ''
      rows += `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${v.home}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:bold;font-size:16px">${v.pick}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${v.away}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${v.tier}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${v.confidence}%</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:center">${v.value ? v.value.odds.toFixed(2) : '-'}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee">${valBadge} ${trapBadge} ${kellyInfo}</td>
      </tr>`
    }

    const valueCount = sheet.highlights.valueBets.length
    const trapCount = sheet.highlights.traps.length
    const solidCount = sheet.highlights.solids.length

    const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Daily Betting Sheet</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { font-family: 'Segoe UI', sans-serif; background:#0d1117; color:#c9d1d9; padding:20px }
  h1 { font-size:24px; margin-bottom:5px; color:#fff }
  .subtitle { color:#8b949e; font-size:14px; margin-bottom:20px }
  .stats { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap }
  .stat { background:#161b22; padding:12px 16px; border-radius:8px; border:1px solid #30363d }
  .stat .num { font-size:24px; font-weight:bold; color:#58a6ff }
  .stat .label { font-size:12px; color:#8b949e }
  table { width:100%; border-collapse:collapse; background:#161b22; border-radius:8px; overflow:hidden }
  th { background:#21262d; padding:10px 8px; text-align:left; font-size:12px; text-transform:uppercase; color:#8b949e; border-bottom:2px solid #30363d }
  td { padding:10px 8px; border-bottom:1px solid #21262d; font-size:13px }
  tr:hover { background:#1c2128 }
  .footer { margin-top:20px; text-align:center; font-size:12px; color:#8b949e }
  @media print { body { padding:10px; background:#fff; color:#000 } .stat { background:#f6f8fa; border-color:#d0d7de } table { background:#fff } th { background:#f6f8fa } tr:hover { background:#f6f8fa } }
</style></head>
<body>
  <h1>📋 Daily Betting Sheet</h1>
  <div class="subtitle">${date} — ${sheet.total} matchs analysés</div>
  <div class="stats">
    <div class="stat"><div class="num">${solidCount}</div><div class="label">💎 Solides</div></div>
    <div class="stat"><div class="num">${valueCount}</div><div class="label">🔥 Value Bets</div></div>
    <div class="stat"><div class="num">${trapCount}</div><div class="label">🚨 Pièges</div></div>
    <div class="stat"><div class="num">${sheet.verdicts.filter((v) => v.kelly > 0).length}</div><div class="label">💰 Kelly > 0</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Domicile</th><th>Pick</th><th>Extérieur</th><th>Tier</th><th>Conf</th><th>Cote</th><th>Infos</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">Généré par Unified Engine — Données en temps réel</div>
</body></html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (e) {
    logger.error(`[UNIFIED] Daily sheet error: ${e.message}`)
    res.status(500).send(`<h1>Erreur</h1><p>${e.message}</p>`)
  }
})

/**
 * GET /api/unified/alerts
 * Returns high-value alerts (EV > 5%, traps, etc.)
 */
router.get('/alerts', async (req, res) => {
  try {
    const matches = await database.getMatchesByStatuses([
      'scheduled',
      'upcoming',
      'NOT_STARTED',
      'NS',
    ])
    const sheet = UnifiedEngine.buildDailySheet(matches)

    const alerts = []

    // High value alerts
    for (const v of sheet.highlights.valueBets) {
      if (v.value && v.value.ev > 5) {
        alerts.push({
          type: 'VALUE',
          severity: 'HIGH',
          home: v.home,
          away: v.away,
          pick: v.pick,
          odds: v.value.odds,
          ev: v.value.ev,
          kelly: v.kelly,
          message: `🔥 VALUE ${v.home} vs ${v.away}: ${v.pick} @ ${v.value.odds} (EV+${v.value.ev}%)`,
        })
      }
    }

    // Trap alerts
    for (const v of sheet.highlights.traps) {
      alerts.push({
        type: 'TRAP',
        severity: 'HIGH',
        home: v.home,
        away: v.away,
        detail: v.trapDetail,
        message: `🚨 PIEGE ${v.home} vs ${v.away}: ${v.trapDetail}`,
      })
    }

    // Solid picks with good odds
    for (const v of sheet.highlights.solids) {
      if (v.value && v.value.ev > 0 && v.confidence >= 80) {
        alerts.push({
          type: 'SOLID',
          severity: 'MEDIUM',
          home: v.home,
          away: v.away,
          pick: v.pick,
          odds: v.value.odds,
          confidence: v.confidence,
          message: `💎 SOLIDE ${v.home} vs ${v.away}: ${v.pick} @ ${v.value.odds} (confiance ${v.confidence}%)`,
        })
      }
    }

    alerts.sort((a, b) => {
      const order = { HIGH: 0, MEDIUM: 1 }
      return (order[a.severity] || 2) - (order[b.severity] || 2)
    })

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      total: alerts.length,
      alerts,
    })
  } catch (e) {
    logger.error(`[UNIFIED] Alerts error: ${e.message}`)
    res.status(500).json({ success: false, error: e.message })
  }
})

module.exports = router
