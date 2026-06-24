const express = require('express');
const router = express.Router();
const logger = require('../core/logger');
const { speedCache } = require('../core/speedCache');
const { scrapePromosport } = require('../core/promosport_scraper');
const { generatePromosportGrids, generateGoldCoupon } = require('../core/promosport_engine');
const promosportIntelligence = require('../services/promosportIntelligence');
const doubleOptimizer = require('../services/doubleOptimizerService');

async function fetchOrFallback() {
  try {
    const scraped = await scrapePromosport()
    if (scraped && scraped.length === 13) return scraped
  } catch (e) {
    logger.error('❌ [PROMOSPORT] Scraper crashed:', e.message)
  }
  logger.warn('⚠️ [PROMOSPORT] Using 13-match fallback data.')
  return [
    { id: 1, homeTeam: "VALENCE", awayTeam: "ATLETICO MADRID", homeWinProbability: 0.18, drawProbability: 0.18, awayWinProbability: 0.64, matchTime: "sam 15:15", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 2, homeTeam: "DEPORTIVO ALAVES", awayTeam: "ATHLETIC BILBAO", homeWinProbability: 0.44, drawProbability: 0.14, awayWinProbability: 0.42, matchTime: "sam 17:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 3, homeTeam: "LEVERKUSEN", awayTeam: "RB LEIPZIG", homeWinProbability: 0.42, drawProbability: 0.18, awayWinProbability: 0.40, matchTime: "sam 17:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 4, homeTeam: "HOFFENHEIM", awayTeam: "STUTTGART", homeWinProbability: 0.30, drawProbability: 0.32, awayWinProbability: 0.38, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 5, homeTeam: "EINTRACHT FRANCFORT", awayTeam: "HAMBOURG", homeWinProbability: 0.68, drawProbability: 0.23, awayWinProbability: 0.09, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 6, homeTeam: "UNION BERLIN", awayTeam: "FC COLOGNE", homeWinProbability: 0.41, drawProbability: 0.44, awayWinProbability: 0.15, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 7, homeTeam: "WERDER BREME", awayTeam: "AUGSBURG", homeWinProbability: 0.33, drawProbability: 0.33, awayWinProbability: 0.34, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 8, homeTeam: "BAYERN MUNICH", awayTeam: "HEIDENHEIM", homeWinProbability: 0.72, drawProbability: 0.21, awayWinProbability: 0.07, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 9, homeTeam: "WOLVERHAMPTON", awayTeam: "SUNDERLAND", homeWinProbability: 0.27, drawProbability: 0.18, awayWinProbability: 0.55, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 10, homeTeam: "BRENTFORD", awayTeam: "WEST HAM", homeWinProbability: 0.34, drawProbability: 0.17, awayWinProbability: 0.49, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 11, homeTeam: "EVERTON", awayTeam: "IPSWICH TOWN", homeWinProbability: 0.17, drawProbability: 0.36, awayWinProbability: 0.47, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 12, homeTeam: "ARSENAL", awayTeam: "MANCHESTER CITY", homeWinProbability: 0.66, drawProbability: 0.20, awayWinProbability: 0.14, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" },
    { id: 13, homeTeam: "BRIGHTON", awayTeam: "MANCHESTER UTD", homeWinProbability: 0.38, drawProbability: 0.24, awayWinProbability: 0.38, matchTime: "sam 14:30", concoursNumber: "856", concoursDate: "02/05/2026" }
  ]
}

/**
 * GET /api/promosport
 * Returns a unified Promosport grid (13 matches with 4 columns).
 */
router.get('/', speedCache('promosport', 300000, 1800000), async (req, res) => {
  try {
    logger.info('🚀 [PROMOSPORT] Fetching grid data...')
    const scrapedMatches = await fetchOrFallback()

    // UNIFY DATA STRUCTURE for Frontend
    // Convert backend grids array into a single matches array with cols
    const grids = await generatePromosportGrids(scrapedMatches);
    
    if (!grids || grids.length === 0) {
        throw new Error("Grid generation failed");
    }

    const unifiedMatches = scrapedMatches.map((m, idx) => {
        const gridMatch = grids[0].matches[idx]; // Reference for intel/brief
        
        return {
            id: idx + 1,
            home: m.homeTeam.replace(/%/g, '').trim(),
            away: m.awayTeam.replace(/%/g, '').trim(),
            comp: (m.leagueName || "Promosport").replace(/%/g, '').trim(),
            time: m.matchTime || '---',
            probs: {
                h: Math.round((m.homeWinProbability || 0.33) * 100),
                x: Math.round((m.drawProbability || 0.33) * 100),
                a: Math.round((m.awayWinProbability || 0.33) * 100)
            },
            cols: [
                { pred: grids[0].matches[idx].choices.join('') },
                { pred: grids[1].matches[idx].choices.join('') },
                { pred: grids[2].matches[idx].choices.join('') },
                { pred: grids[3].matches[idx].choices.join('') }
            ],
            intel: gridMatch.intel,
            brief: gridMatch.brief
        };
    });

    const firstMatch = scrapedMatches[0] || {};
    const finalConcours = firstMatch.concoursNumber || '855';
    const finalDate = firstMatch.concoursDate || new Date().toLocaleDateString();

    console.log(`✅ [PROMOSPORT] Sending ${unifiedMatches.length} matches to frontend for Concours ${finalConcours}`);
    res.json({
        concours: finalConcours,
        date: finalDate,
        matches: unifiedMatches
    });

  } catch (err) {
    logger.error('❌ [PROMOSPORT] Final Error:', err.message);
    res.status(500).json({ error: "Erreur critique lors de la génération de la grille. Fallback échoué." });
  }
});

/**
 * GET /api/promosport/gold-coupon
 * Returns a Gold Coupon with 6 doubles + 7 singles, prioritizing surprises.
 */
router.get('/gold-coupon', speedCache('promosport_gold', 300000, 1800000), async (req, res) => {
  try {
    const scrapedMatches = await fetchOrFallback()
    const grids = await generatePromosportGrids(scrapedMatches)
    if (!grids || grids.length === 0) throw new Error('Grid generation failed')

    const enriched = scrapedMatches.map((m, idx) => ({
      ...m,
      p1: grids[0].matches[idx].p1 || m.homeWinProbability,
      px: grids[0].matches[idx].px || m.drawProbability,
      p2: grids[0].matches[idx].p2 || m.awayWinProbability,
      entropy: grids[0].matches[idx].entropy || 1.5,
      confidence: grids[0].matches[idx].confidence || 50,
      isCrowdTrap: grids[0].matches[idx].isCrowdTrap || false,
      intel: grids[0].matches[idx].intel,
      tacticalBrief: grids[0].matches[idx].brief || ''
    }))
    const goldCoupon = generateGoldCoupon(enriched)

    const firstMatch = scrapedMatches[0] || {}
    res.json({
      success: true,
      concours: firstMatch.concoursNumber || 'N/A',
      date: firstMatch.concoursDate || new Date().toLocaleDateString(),
      coupon: goldCoupon,
      generatedAt: new Date().toISOString()
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Gold Coupon Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/secret-weapons
 * Renvoie les "armes secrètes" : analyses contrarian, bases solides, enjeux réels.
 */
router.get('/secret-weapons', speedCache('promosport_weapons', 300000, 1800000), async (req, res) => {
  try {
    const scrapedMatches = await fetchOrFallback()
    const grids = await generatePromosportGrids(scrapedMatches)
    if (!grids || grids.length === 0) throw new Error('Grid generation failed')

    const enriched = scrapedMatches.map((m, idx) => ({
      ...m,
      p1: grids[0].matches[idx].p1 || m.homeWinProbability,
      px: grids[0].matches[idx].px || m.drawProbability,
      p2: grids[0].matches[idx].p2 || m.awayWinProbability,
      entropy: grids[0].matches[idx].entropy || 1.5,
      confidence: grids[0].matches[idx].confidence || 50,
      isCrowdTrap: grids[0].matches[idx].isCrowdTrap || false,
      isHighPressure: grids[0].matches[idx].isHighPressure || false,
      intel: grids[0].matches[idx].intel,
      tacticalBrief: grids[0].matches[idx].brief || ''
    }))

    const weapons = await promosportIntelligence.generateSecretWeapons(enriched)

    const weaponsWithChoices = weapons.map((w, idx) => ({
      ...w,
      choices: grids.map(g => g.matches[idx].choices.join('')),
    }))

    res.json({
      success: true,
      concours: scrapedMatches[0]?.concoursNumber || 'N/A',
      date: scrapedMatches[0]?.concoursDate || new Date().toLocaleDateString(),
      weapons: weaponsWithChoices,
      stats: {
        totalMatches: weaponsWithChoices.length,
        contrarianCount: weaponsWithChoices.filter(w => w.isContrarian).length,
        survivalCount: weaponsWithChoices.filter(w => w.isSurvival).length,
        deadRubberCount: weaponsWithChoices.filter(w => w.isDeadRubber).length,
        bTeamCount: weaponsWithChoices.filter(w => w.bTeamHome?.isBTeam || w.bTeamAway?.isBTeam).length,
        boldCount: weaponsWithChoices.filter(w => (w.boldness?.label || '').includes('BOLD')).length,
        valueCount: weaponsWithChoices.filter(w => (w.boldness?.label || '').includes('VALUE')).length,
        historicalConcours: promosportIntelligence.getConcoursCount() || 0
      }
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Secret Weapons Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/analysis
 * Analyse détaillée : bases solides + armes secrètes + conseils stratégiques
 */
router.get('/analysis', speedCache('promosport_analysis', 300000, 1800000), async (req, res) => {
  try {
    const scrapedMatches = await fetchOrFallback()
    const grids = await generatePromosportGrids(scrapedMatches)

    const solidBases = (scrapedMatches || []).map((m, idx) => {
      const gm = grids?.[0]?.matches?.[idx]
      const pMax = Math.max(gm?.p1 || 0, gm?.px || 0, gm?.p2 || 0)
      const bestPick = gm?.p1 === pMax ? '1' : (gm?.p2 === pMax ? '2' : 'X')
      const confidence = gm?.confidence || 50
      return {
        id: idx + 1,
        match: `${m.homeTeam} - ${m.awayTeam}`,
        pick: bestPick,
        confidence: `${confidence}%`,
        isSolid: confidence >= 70
      }
    })

    res.json({
      success: true,
      concours: scrapedMatches[0]?.concoursNumber || 'N/A',
      date: scrapedMatches[0]?.concoursDate || new Date().toLocaleDateString(),
      solidBases,
      strategy: {
        budgetMax: '15 DT',
        prixColonne: '0.850 DT',
        colonnesMax: 17,
        doublesRecommandes: 5,
        conseil: 'Jouer 5 doubles sur les matchs à haute entropie avec 4 colonnes (3.40 DT). Utiliser le budget restant (11.60 DT) pour des colonnes supplémentaires couvrant plus de combinaisons.'
      }
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Analysis Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/print
 * HTML page imprimable pour le point de vente Promosport
 */
router.get('/print', speedCache('promosport_print', 60000, 300000), async (req, res) => {
  try {
    const scrapedMatches = await fetchOrFallback()
    const grids = await generatePromosportGrids(scrapedMatches)
    if (!grids || grids.length === 0) throw new Error('Grid generation failed')

    const concours = scrapedMatches[0]?.concoursNumber || 'N/A'
    const date = scrapedMatches[0]?.concoursDate || new Date().toLocaleDateString()

    let rows = ''
    scrapedMatches.forEach((m, idx) => {
      const g0 = grids[0]?.matches[idx]?.choices?.join('') || '-'
      const g1 = grids[1]?.matches[idx]?.choices?.join('') || '-'
      const g2 = grids[2]?.matches[idx]?.choices?.join('') || '-'
      const g3 = grids[3]?.matches[idx]?.choices?.join('') || '-'
      const isDouble = [g0, g1, g2, g3].some(c => c.length > 1)
      rows += `
        <tr${isDouble ? " class='double'" : ''}>
          <td class='num'>${idx + 1}</td>
          <td class='team'>${m.homeTeam}</td>
          <td class='pick'>${g0 || '-'}</td>
          <td class='pick'>${g1 || '-'}</td>
          <td class='pick'>${g2 || '-'}</td>
          <td class='pick'>${g3 || '-'}</td>
          <td class='team'>${m.awayTeam}</td>
        </tr>`
    })

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Ticket Promosport N°${concours}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Courier New', monospace; background:#fff; color:#000; padding:20px; }
    h1 { text-align:center; font-size:20px; margin-bottom:5px; }
    h2 { text-align:center; font-size:14px; font-weight:normal; color:#555; margin-bottom:20px; }
    table { width:100%; border-collapse:collapse; margin-bottom:20px; }
    th { background:#e0e0e0; padding:8px 4px; font-size:10px; text-transform:uppercase; border:1px solid #ccc; }
    td { padding:6px 4px; font-size:11px; border:1px solid #ccc; text-align:center; }
    td.team { text-align:left; padding-left:8px; }
    td.num { font-weight:bold; }
    td.pick { font-weight:bold; font-size:14px; letter-spacing:2px; }
    .double td { background:#e8f5e9; }
    .double td.pick { color:#2e7d32; }
    .footer { text-align:center; margin-top:20px; font-size:12px; }
    .footer b { font-size:16px; }
    .legend { font-size:11px; color:#666; margin-top:10px; }
    @media print { body { padding:10px; } th { background:#e0e0e0 !important; } }
  </style>
</head>
<body>
  <h1>PROMOSPORT TUNISIE — CONCOURS N°${concours}</h1>
  <h2>Grille imprimable — ${date} — 4 colonnes × 0,850 DT = 3,40 DT</h2>
  <table>
    <thead>
      <tr>
        <th>N°</th>
        <th>Équipe 1</th>
        <th>G1</th>
        <th>G2</th>
        <th>G3</th>
        <th>G4</th>
        <th>Équipe 2</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class='footer'>
    <p><b>3,40 DT</b> — 4 colonnes — Budget restant: 11,60 DT</p>
    <p class='legend'>Lignes en vert = matchs en double chance. Cochez les cases correspondantes au point de vente.</p>
  </div>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Print Error:', err.message)
    res.status(500).send('<h1>Erreur</h1><p>' + err.message + '</p>')
  }
})

/**
 * GET /api/promosport/double-sim
 * Simulation de l'impact des doubles-chances sur le taux de réussite attendu.
 */
router.get('/double-sim', speedCache('promosport_doublesim', 300000, 1800000), async (req, res) => {
  try {
    const scrapedMatches = await fetchOrFallback()
    const grids = await generatePromosportGrids(scrapedMatches)
    if (!grids || grids.length === 0) throw new Error('Grid generation failed')

    const enriched = scrapedMatches.map((m, idx) => ({
      ...m,
      p1: grids[0].matches[idx].p1 || m.homeWinProbability,
      px: grids[0].matches[idx].px || m.drawProbability,
      p2: grids[0].matches[idx].p2 || m.awayWinProbability,
    }))

    const simulation = doubleOptimizer.simulateDoubleCounts(enriched)
    const optimal = doubleOptimizer.selectOptimalDoubles(enriched, 5)

    res.json({
      success: true,
      concours: scrapedMatches[0]?.concoursNumber || 'N/A',
      simulation,
      optimal,
      recommendation: {
        suggestedDoubles: 5,
        expectedCorrectWith5: optimal.expectedCorrect.withDoubles,
        expectedCorrectAllSingles: optimal.expectedCorrect.allSingles,
        improvement: `+${((optimal.expectedCorrect.withDoubles / optimal.expectedCorrect.allSingles - 1) * 100).toFixed(1)}%`,
        bestMatches: optimal.ranked.filter(m => m.selected).map(m => ({
          id: m.id,
          match: `${m.home} vs ${m.away}`,
          single: m.bestSingle,
          double: m.bestDouble,
          gain: m.gainPct,
          coverage: m.doubleCoverage,
        })),
      }
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Double Sim Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

module.exports = router;