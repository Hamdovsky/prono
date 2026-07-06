const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const Database = require('better-sqlite3');
const logger = require('../core/logger');
const { speedCache } = require('../core/speedCache');
const { scrapePromosport } = require('../core/promosport_scraper');
const { generatePromosportGrids, generateGoldCoupon } = require('../core/promosport_engine');
const promosportIntelligence = require('../services/promosportIntelligence');
const doubleOptimizer = require('../services/doubleOptimizerService');
const { scrapeTunisieGrid } = require('../core/promosport_tunisie_scraper');
const crowdHackerService = require('../services/crowdHackerService');
const secretWeaponsTracker = require('../services/secretWeaponsTracker');
const promosportResultService = require('../services/promosportResultService');

// ─── Team Name Normalization ──────────────────────────────────────────────
const TEAM_ALIASES = {
  'maroc': 'morocco', 'norvège': 'norway', 'norvege': 'norway',
  'suisse': 'switzerland', 'suéde': 'sweden', 'suede': 'sweden',
  'allemagne': 'germany', 'angleterre': 'england', 'espagne': 'spain',
  'italie': 'italy', 'portugal': 'portugal', 'belgique': 'belgium',
  'pays-bas': 'netherlands', 'pays bas': 'netherlands', 'holanda': 'netherlands',
  'í¡rabe': 'saudi arabia', 'arabe saoudite': 'saudi arabia',
  'japon': 'japan', 'corée': 'south korea', 'coree': 'south korea',
  'états-unis': 'usa', 'etats unis': 'usa', 'etats-unis': 'usa',
  'brésil': 'brazil', 'bresil': 'brazil', 'mexique': 'mexico',
  'tunisie': 'tunisia', 'algérie': 'algeria', 'algerie': 'algeria',
  'cameroun': 'cameroon', 'côte d\'ivoire': 'ivory coast',
  'sénégal': 'senegal', 'senegal': 'senegal',
  'ní¨mes': 'nimes', 'nimes': 'nimes',
  'marseille': 'olympique marseille', 'om': 'olympique marseille',
  'psg': 'paris saint germain', 'paris sg': 'paris saint germain',
}

function normalizeTeamName(name) {
  let n = name.toLowerCase().trim()
  // Remove accents
  n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  // Apply aliases
  n = TEAM_ALIASES[n] || n
  return n
}

function normalizeMatchNames(matches) {
  return matches.map(m => ({
    ...m,
    homeTeam: normalizeTeamName(m.homeTeam),
    awayTeam: normalizeTeamName(m.awayTeam)
  }))
}

// ─── Archive Helper ──────────────────────────────────────────────────────────
const ARCHIVE_PATH = require('path').join(__dirname, '..', 'data', 'historical_archive.sqlite');
function archiveScrapedMatches(concours, date, matches) {
  try {
    const db = new Database(ARCHIVE_PATH);
    const insertMatch = db.prepare(`
      INSERT OR IGNORE INTO promosport_archive 
        (concours, date, homeTeam, awayTeam, match_idx, archived_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `);
    const insertGrid = db.prepare(`
      INSERT OR REPLACE INTO promosport_grids (concours, date, grid_data, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    const tx = db.transaction(() => {
      matches.forEach((m, idx) => {
        insertMatch.run(concours, date, m.homeTeam, m.awayTeam, idx + 1);
      });
      insertGrid.run(concours, date, JSON.stringify(matches));
    });
    tx();
    db.close();
  } catch (e) {
    logger.warn(`[ARCHIVE] Failed to archive concours ${concours}: ${e.message}`);
  }
}

function parsePromosportPronostic(html) {
  let concoursNumber = '878'
  let concoursDate = new Date().toISOString().slice(0, 10)

  const titleMatch = html.match(/Promosport N[°]\s*(\d+)/i)
  if (titleMatch) concoursNumber = titleMatch[1]
  const dateMatch = html.match(/Du\s+(\d{4}-\d{2}-\d{2})\s+/i)
  if (dateMatch) concoursDate = dateMatch[1]

  const matches = []
  const seenPairs = new Set()
  let rowPos = 0

  // Scan ALL <tr> in the document. Process rows from BOTH tables (prono + votes)
  // Deduplicate by team names to get exactly 13 unique matches.
  while ((rowPos = html.indexOf('<tr', rowPos)) !== -1 && matches.length < 13) {
    const trEnd = html.indexOf('</tr>', rowPos)
    if (trEnd === -1) break
    const row = html.substring(rowPos, trEnd + 5)

    // Check if first cell has a match number 1-13
    const firstTdEnd = row.indexOf('</td>')
    const firstTd = firstTdEnd > 0 ? row.substring(0, firstTdEnd + 5) : row
    const textContent = firstTd.replace(/<[^>]*>/g, '').trim()
    const txtMatch = textContent.match(/^(\d{1,2})$/)
    const id = txtMatch ? parseInt(txtMatch[1]) : 0
    if (id < 1 || id > 13) { rowPos = trEnd + 5; continue }

    // Extract team names from this row
    const links = []
    const lr = /<a[^>]*class="nline"[^>]*>([^<]+)<\/a>/gi
    let lm
    while ((lm = lr.exec(row)) !== null) {
      const t = lm[1].trim()
      if (t.length > 1 && !/^\d+$/.test(t)) links.push(t)
    }
    if (links.length < 2) { rowPos = trEnd + 5; continue }

    const rawHome = links[0].toUpperCase().trim()
    const rawAway = links[1].toUpperCase().trim()
    const normHome = normalizeTeamName(rawHome)
    const normAway = normalizeTeamName(rawAway)
    const dupKey = `${normHome}_vs_${normAway}`
    const revKey = `${normAway}_vs_${normHome}`
    if (seenPairs.has(dupKey) || seenPairs.has(revKey)) { rowPos = trEnd + 5; continue }
    seenPairs.add(dupKey)

    matches.push({
      id: matches.length + 1,
      homeTeam: rawHome,
      awayTeam: rawAway,
      leagueName: 'Promosport',
      homeWinProbability: 0.33,
      drawProbability: 0.33,
      awayWinProbability: 0.34,
      matchTime: '---',
      concoursDate,
      concoursNumber
    })
    rowPos = trEnd + 5
  }

  // Pad with placeholders if needed
  while (matches.length < 13) {
    matches.push({
      id: matches.length + 1,
      homeTeam: 'Match ' + (matches.length + 1),
      awayTeam: 'À déterminer',
      leagueName: 'Promosport',
      homeWinProbability: 0.33,
      drawProbability: 0.33,
      awayWinProbability: 0.34,
      matchTime: '---',
      concoursDate,
      concoursNumber
    })
  }
  return matches
}

let _fallbackCache = null
let _fallbackCacheTime = 0
const FALLBACK_CACHE_TTL = 300000 // 5 min

async function fetchOrFallback() {
  const now = Date.now()
  if (_fallbackCache && (now - _fallbackCacheTime) < FALLBACK_CACHE_TTL) {
    return _fallbackCache
  }
  try {
    const scraped = await scrapePromosport()
    if (scraped && scraped.length === 13) {
      _fallbackCache = scraped
      _fallbackCacheTime = now
      return scraped
    }
  } catch (e) {
    logger.error('❌ [PROMOSPORT] Scraper crashed:', e.message)
  }
    // Backup: try promosport-pronostic.com
    try {
        const backupUrl = 'https://www.promosport-pronostic.com/index.php/welcome/promo_pronostic?jeux=Promosport'
    logger.info('📡 [PROMOSPORT] Trying backup source:', backupUrl)
    const resp = await axios.get(backupUrl, {
      httpsAgent: new https.Agent({ keepAlive: true }),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9'
      },
      timeout: 30000
    })
    const html = resp.data
    const backupMatches = parsePromosportPronostic(html)
    if (backupMatches && backupMatches.length === 13) {
      logger.info(`✅ [PROMOSPORT] Backup scrape returned ${backupMatches.length} matches`)
      _fallbackCache = backupMatches
      _fallbackCacheTime = now
      return backupMatches
    }
  } catch (e) {
    logger.error('❌ [PROMOSPORT] Backup scrape failed:', e.message)
  }
    logger.error('❌ [PROMOSPORT] Aucun scrape réussi — grille indisponible.')
  return []
}

/**
 * GET /api/promosport
 * Returns a unified Promosport grid (13 matches with 4 columns).
 */
router.get('/', speedCache('promosport', 300000, 1800000), async (req, res) => {
  try {
    logger.info('🚀 [PROMOSPORT] Fetching grid data...')
    let scrapedMatches = await fetchOrFallback()

    // Normalize team names consistently (MAROC → MOROCCO, NORVÈGE → NORWAY)
    if (scrapedMatches && scrapedMatches.length > 0) {
      scrapedMatches = normalizeMatchNames(scrapedMatches)
      logger.info(`🧹 [PROMOSPORT] Normalised ${scrapedMatches.length} matches`)
    }

    // Archive this scrape for historical analysis
    if (scrapedMatches && scrapedMatches.length > 0) {
      const first = scrapedMatches[0] || {};
      archiveScrapedMatches(first.concoursNumber || 'unknown', first.concoursDate || new Date().toISOString(), scrapedMatches);
    }

    // Custom doubles per grid from query params: ?d1=4&d2=4&d3=4&d4=4
    const customDoubles = [
      parseInt(req.query.d1) || null,
      parseInt(req.query.d2) || null,
      parseInt(req.query.d3) || null,
      parseInt(req.query.d4) || null
    ];

    // UNIFY DATA STRUCTURE for Frontend
    // Convert backend grids array into a single matches array with cols
    const grids = await generatePromosportGrids(scrapedMatches, customDoubles);
    
    if (!grids || grids.length === 0) {
        throw new Error("Grid generation failed");
    }

    const unifiedMatches = scrapedMatches.map((m, idx) => {
        const gridMatch = grids[0].matches[idx]; // Reference for intel/brief
        
        // Check if any grid was diversified (anti-public trap)
        let diversifyReason = null
        for (let gi = 0; gi < grids.length; gi++) {
          if (grids[gi].matches[idx].diversified) {
            diversifyReason = grids[gi].matches[idx].diversifyReason
            break
          }
        }
        
        return {
            id: idx + 1,
            home: m.homeTeam.replace(/%/g, '').trim(),
            away: m.awayTeam.replace(/%/g, '').trim(),
            comp: (m.leagueName || "Promosport").replace(/%/g, '').trim(),
            time: m.matchTime || '---',
            probs: {
                h: Math.round((gridMatch.crowdP1 || m.homeWinProbability || 0.33) * 100),
                x: Math.round((m.drawProbability || 0.33) * 100),
                n: Math.round((m.drawProbability || 0.33) * 100),
                a: Math.round((gridMatch.crowdP2 || m.awayWinProbability || 0.33) * 100)
            },
            mlProbs: {
                h: Math.round((gridMatch.p1 || 0.33) * 100),
                x: Math.round((gridMatch.px || 0.33) * 100),
                n: Math.round((gridMatch.px || 0.33) * 100),
                a: Math.round((gridMatch.p2 || 0.33) * 100)
            },
            cols: grids.map(g => ({ pred: g.matches[idx].choices.join(''), name: g.name })),
            intel: gridMatch.intel,
            brief: gridMatch.brief,
            diversifyReason,
            crowdTraps: {
              isCrowdTrap: gridMatch.isCrowdTrap || false,
              isAwayCrowdTrap: gridMatch.isAwayCrowdTrap || false,
              publicOverconfidence: gridMatch.publicOverconfidence || false
            }
        };
    });

    const firstMatch = scrapedMatches[0] || {};
    const finalConcours = firstMatch.concoursNumber || '878';
    const finalDate = firstMatch.concoursDate || new Date().toLocaleDateString();

    // Archive predictions in Neon PostgreSQL
    try {
      const { Pool } = require('pg')
      const dbUrl = process.env.DATABASE_URL
      if (dbUrl) {
        const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 1 })
        const payload = JSON.stringify({
          date: finalDate,
          matches: unifiedMatches.map(m => ({
            id: m.id, home: m.home, away: m.away,
            cols: m.cols.map(c => ({ pred: c.pred, name: c.name }))
          }))
        })
        await pool.query(
          `INSERT INTO promosport_predictions (concours, date, data) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (concours) DO UPDATE SET data = $3::jsonb, date_archived = NOW()`,
          [finalConcours, finalDate, payload]
        )
        await pool.end()
      }
    } catch (_) {}

    // Store predictions in local SQLite archive for accuracy tracking
    try {
      promosportResultService.storePrediction(finalConcours, finalDate, grids);
    } catch (_) {}

    console.log(`✅ [PROMOSPORT] Sending ${unifiedMatches.length} matches to frontend for Concours ${finalConcours}`);
    res.json({
        concours: finalConcours,
        date: finalDate,
        matches: unifiedMatches,
        gridStats: grids.map(g => ({ name: g.name, doubles: g.stats.totalDoubles, avgConfidence: parseFloat(g.stats.avgConfidence) }))
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

    const enriched = scrapedMatches.map((m, idx) => {
      const gm = grids[0].matches[idx]
      return {
        ...m,
        p1: gm.p1 || m.homeWinProbability,
        px: gm.px || m.drawProbability,
        p2: gm.p2 || m.awayWinProbability,
        mlProbs: { h: gm.p1, x: gm.px, a: gm.p2 },
        probs: { h: m.homeWinProbability, x: m.drawProbability, a: m.awayWinProbability },
        entropy: gm.entropy || 1.5,
        confidence: gm.confidence || 50,
        isCrowdTrap: gm.isCrowdTrap || false,
        isAwayCrowdTrap: gm.isAwayCrowdTrap || false,
        publicOverconfidence: gm.publicOverconfidence || false,
        isHighPressure: gm.isHighPressure || false,
        intel: gm.intel,
        tacticalBrief: gm.brief || ''
      }
    })

    const result = await promosportIntelligence.generateSecretWeapons(enriched)
    const weapons = result.weapons
    const gridHints = result.gridHints

    const llmAnalyses = await promosportIntelligence.generateLLMSecretWeapons(enriched)

    const weaponsWithChoices = weapons.map((w, idx) => {
      const gm = grids[0].matches[idx]
      const trapAnalysis = crowdHackerService.detectPublicTrap({
        homeWinProbability: enriched[idx].homeWinProbability,
        drawProbability: enriched[idx].drawProbability,
        awayWinProbability: enriched[idx].awayWinProbability,
        p1: gm.p1, px: gm.px, p2: gm.p2,
      })

      let diversifyReason = null
      for (let gi = 0; gi < 4; gi++) {
        if (grids[gi].matches[idx].diversified) {
          diversifyReason = grids[gi].matches[idx].diversifyReason
          break
        }
      }

      const llm = llmAnalyses ? llmAnalyses.find(a => a.id === w.id) : null

      let llmSecretWeapon = null
      if (llm && llm.secretWeapon) {
        llmSecretWeapon = {
          text: llm.secretWeapon,
          confidence: llm.confidence || null,
          risk: llm.risk || null,
        }
      }

      return {
        ...w,
        choices: grids.map(g => g.matches[idx].choices.join('')),
        trapAnalysis,
        diversifyReason,
        llmSecretWeapon,
      }
    })

    const trapCount = weaponsWithChoices.filter(w => w.trapAnalysis?.isTrap).length
    const awayTrapCount = weaponsWithChoices.filter(w => w.trapAnalysis?.isAwayTrap).length
    const diversifiedCount = weaponsWithChoices.filter(w => w.diversifyReason).length

    const concours = scrapedMatches[0]?.concoursNumber || 'N/A'
    secretWeaponsTracker.recordPrediction(concours, weapons)

    try {
      const socketService = require('../services/socketService')
      socketService.broadcast('promosport_weapons_update', {
        concours,
        weaponsCount: weaponsWithChoices.length,
        contrarianCount: weaponsWithChoices.filter(w => w.isContrarian).length,
        timestamp: new Date().toISOString(),
      })
    } catch (e) {}

    res.json({
      success: true,
      concours,
      date: scrapedMatches[0]?.concoursDate || new Date().toLocaleDateString(),
      weapons: weaponsWithChoices,
      gridNames: grids.map(g => g.name),
      gridHints,
      stats: {
        totalMatches: weaponsWithChoices.length,
        contrarianCount: weaponsWithChoices.filter(w => w.isContrarian).length,
        survivalCount: weaponsWithChoices.filter(w => w.isSurvival).length,
        deadRubberCount: weaponsWithChoices.filter(w => w.isDeadRubber).length,
        bTeamCount: weaponsWithChoices.filter(w => w.bTeamHome?.isBTeam || w.bTeamAway?.isBTeam).length,
        boldCount: weaponsWithChoices.filter(w => (w.boldness?.label || '').includes('BOLD')).length,
        valueCount: weaponsWithChoices.filter(w => (w.boldness?.label || '').includes('VALUE')).length,
        trapCount,
        awayTrapCount,
        diversifiedCount,
        historicalConcours: promosportIntelligence.getConcoursCount() || 0,
        avgEdge: gridHints.avgEdge,
        hasLLM: !!llmAnalyses,
      },
      strategy: trapCount > 0
        ? `🔥 ${trapCount} piège(s) public(s) détecté(s) — ${diversifiedCount} grille(s) diversifiée(s) — Jouer les picks CONTRARIAN`
        : '✅ Aucun piège public majeur détecté cette semaine'
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

/**
 * GET /api/promosport/tunisie/:grid
 * Scrape a Tunisian Promosport grid and analyze crowd
 */
router.get('/tunisie/:grid', speedCache('promosport_tn', 120000, 600000), async (req, res) => {
  try {
    const gridNo = parseInt(req.params.grid)
    if (isNaN(gridNo)) return res.status(400).json({ success: false, error: 'Invalid grid number' })

    const grid = await scrapeTunisieGrid(gridNo)
    if (!grid) return res.status(404).json({ success: false, error: `Grid ${gridNo} not found` })

        // Archive the scraped grid
    try {
      const db = new Database(ARCHIVE_PATH);
      const insertMatch = db.prepare(`
        INSERT OR IGNORE INTO promosport_archive 
          (concours, grid_no, date, homeTeam, awayTeam, match_idx, result, vote_home, vote_draw, vote_away, score_home, score_away, is_finished, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `);
      const insertGrid = db.prepare(`
        INSERT OR REPLACE INTO promosport_grids (concours, date, grid_data, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `);
      const tx = db.transaction(() => {
        grid.matches.forEach(m => {
          insertMatch.run(grid.no, grid.no, null, m.home, m.away, m.idx, m.result || null, m.publicVote?.p1 || null, m.publicVote?.px || null, m.publicVote?.p2 || null, m.scoreHome, m.scoreAway);
        });
        insertGrid.run(grid.no, null, JSON.stringify(grid.matches));
      });
      tx();
      db.close();
    } catch (_) {}

    const analysis = grid.matches.map((m) => {
          const crowdSignal = crowdHackerService.getContrarianSignal({
            publicVote: m.publicVote,
            homeWinProbability: m.publicVote?.p1 ? m.publicVote.p1 / 100 : undefined,
            drawProbability: m.publicVote?.px ? m.publicVote.px / 100 : undefined,
            awayWinProbability: m.publicVote?.p2 ? m.publicVote.p2 / 100 : undefined,
          })

          const picks = m.publicVote
            ? Object.entries({ 1: m.publicVote.p1, X: m.publicVote.px, 2: m.publicVote.p2 })
                .sort((a, b) => b[1] - a[1])
            : null

      return {
        idx: m.idx,
        home: m.home,
        away: m.away,
        score: `${m.scoreHome}-${m.scoreAway}`,
        result: m.result,
        crowdVote: m.publicVote,
        crowdFavorite: picks ? picks[0][0] : null,
        crowdFavoritePct: picks ? picks[0][1] : null,
        crowdCorrect: picks ? picks[0][0] === m.result : null,
        contrarianSignal: crowdSignal?.tunisianCrowd || null,
      }
    })

    const withResult = analysis.filter(a => a.result && a.result !== 'N')
    const crowdRight = withResult.filter(a => a.crowdCorrect).length
    const crowdTotal = withResult.length

    res.json({
      success: true,
      grid: grid.no,
      cagnotte: grid.cagnotte,
      cagnotteFormatted: grid.cagnotte ? `${grid.cagnotte.toLocaleString()} TND` : null,
      matches: analysis,
      crowdSummary: {
        total: crowdTotal,
        right: crowdRight,
        wrong: crowdTotal - crowdRight,
        accuracy: crowdTotal > 0 ? +(crowdRight / crowdTotal * 100).toFixed(1) : null,
      },
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Tunisian Grid Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/calculator
 * Calculateur de combinaisons Promosport
 * Query: cols (nb colonnes jouées), doubles (nb doubles), triples (nb triples, optionnel)
 * Retourne le % global de couverture, coût, et probabilité de gain estimée
 */
router.get('/calculator', speedCache('promosport_calc', 60000, 300000), async (req, res) => {
  try {
    const cols = parseInt(req.query.cols) || 1
    const doubles = parseInt(req.query.doubles) || 0
    const triples = parseInt(req.query.triples) || 0

    if (cols < 1 || cols > 1000) return res.status(400).json({ success: false, error: 'cols must be 1-1000' })
    if (doubles < 0 || doubles > 13) return res.status(400).json({ success: false, error: 'doubles must be 0-13' })
    if (triples < 0 || triples > 13) return res.status(400).json({ success: false, error: 'triples must be 0-13' })
    if (doubles + triples > 13) return res.status(400).json({ success: false, error: 'doubles + triples must be ≤ 13' })

    // Full system calculations
    const fullCols = Math.pow(2, doubles) * Math.pow(3, triples)
    const totalPossible = Math.pow(3, 13) // 3^13 = 1,594,323 combos possibles
    const coveragePct = fullCols > 0 ? Math.min(100, +(cols / fullCols * 100).toFixed(2)) : 0
    const coverageVsTotal = +((cols * (fullCols / Math.max(1, cols))) / totalPossible * 100).toFixed(6)
    const pricePerCol = 0.850
    const taxRate = 0.06
    const costBeforeTax = +(cols * pricePerCol).toFixed(3)
    const costWithTax = +(costBeforeTax * (1 + taxRate)).toFixed(3)

    // Calculate reduction level
    let systemType = 'INTÉGRAL'
    if (fullCols > 0 && cols < fullCols) {
      const ratio = fullCols / cols
      if (ratio >= 16) systemType = `N-${Math.round(Math.log2(ratio))}`
      else if (ratio >= 8) systemType = 'N-1'
      else if (ratio >= 4) systemType = 'N-2 (approx)'
      else systemType = 'RÉDUIT PERSONNALISÉ'
    }

    // Try to get current grid for real probabilities
    let expectedCorrect = null
    let prob13of13 = null
    try {
      const scraped = await scrapePromosport()
      if (scraped && scraped.length === 13) {
        // Use public vote as base probabilities
        let totalProb = 0
        let product13 = 1
        for (const m of scraped) {
          const p1 = m.homeWinProbability || 0.33
          const px = m.drawProbability || 0.33
          const p2 = m.awayWinProbability || 0.34
          const bestProb = Math.max(p1, px, p2)
          totalProb += bestProb
          product13 *= bestProb
        }
        expectedCorrect = +(totalProb).toFixed(2)
        prob13of13 = product13
      }
    } catch (_) {
      // Fallback: use average probability
      expectedCorrect = +(13 * 0.36).toFixed(2)
      prob13of13 = Math.pow(0.36, 13)
    }

    res.json({
      success: true,
      input: { cols, doubles, triples },
      combinations: {
        fullSystem: fullCols,
        played: cols,
        totalPossible,
        reduction: fullCols > 0 ? `${cols}/${fullCols}` : 'N/A',
      },
      coverage: {
        systemCoverage: coveragePct,
        vsTotalPossible: coverageVsTotal,
        description: coveragePct >= 100
          ? '🔵 SYSTÈME INTÉGRAL — Vous jouez toutes les combinaisons possibles de vos doubles'
          : coveragePct >= 50
            ? '🟢 COUVERTURE ÉLEVÉE — Plus de la moitié du système est couvert'
            : coveragePct >= 25
              ? '🟡 COUVERTURE MOYENNE — Risque modéré'
              : '🔴 FAIBLE COUVERTURE — Système réduit, risque élevé',
      },
      pricing: {
        pricePerCol,
        costBeforeTax: `${costBeforeTax.toFixed(3)} DT`,
        tax: `${(costBeforeTax * taxRate).toFixed(3)} DT`,
        total: `${costWithTax} DT`,
      },
      expectedCorrect: expectedCorrect !== null ? expectedCorrect : 'N/A',
      prob13of13: prob13of13 !== null ? prob13of13 : 'N/A',
      systemType,
      advice: coveragePct < 10
        ? `⚠️ Réduction sévère (${coveragePct}%). Envisagez plus de colonnes ou moins de doubles.`
        : coveragePct < 30
          ? `📊 Réduction modérée. ${cols} colonnes pour ${doubles} doubles.`
          : coveragePct >= 100
            ? `✅ Système intégral — 100% de couverture de vos ${doubles} doubles.`
            : `✅ Bonne couverture (${coveragePct}%).`,
    })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Calculator Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/weapons-history
 * Historique des prédictions armes secrètes et leur précision.
 */
router.get('/weapons-history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const history = secretWeaponsTracker.getHistory(limit)
    const stats = secretWeaponsTracker.getStats()
    res.json({ success: true, history, stats })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Weapons History Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * POST /api/promosport/weapons-results
 * Enregistrer les résultats réels d'un concours pour calculer la précision.
 * Body: { concours: "878", results: [{ id: 1, result: "1" }, ...] }
 */
router.post('/weapons-results', async (req, res) => {
  try {
    const { concours, results } = req.body
    if (!concours || !results) {
      return res.status(400).json({ success: false, error: 'Missing concours or results' })
    }
    const outcome = secretWeaponsTracker.recordResults(concours, results)
    if (!outcome) {
      return res.status(404).json({ success: false, error: `Concours ${concours} not found` })
    }
    logger.info(`[PROMOSPORT] Results recorded for concours ${concours}: ${outcome.correct}/${outcome.total} correct (${outcome.accuracy}%)`)
    res.json({ success: true, outcome })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] Weapons Results Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/history
 * Historique des concours passés avec leurs résultats (1/X/2).
 * Query: limit (default 10), offset (default 0)
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10
    const offset = parseInt(req.query.offset) || 0

    // Try PostgreSQL first (Neon)
    try {
      const { Pool } = require('pg')
      const dbUrl = process.env.DATABASE_URL
      if (dbUrl) {
        const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, max: 1 })
        const result = await pool.query(
          'SELECT concours, date, matches FROM promosport_historical_grids ORDER BY concours DESC LIMIT $1 OFFSET $2',
          [limit, offset]
        )
        await pool.end()
        return res.json({ success: true, count: result.rowCount, history: result.rows })
      }
    } catch (pgErr) {
      // Fallback to local file
    }

    // Fallback: read from local JSON file
    const fs = require('fs')
    const path = require('path')
    const historyPath = path.join(__dirname, '..', 'data', 'promosport_historical_results.json')
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      const paginated = data.slice(offset, offset + limit)
      return res.json({ success: true, count: data.length, history: paginated })
    }

    res.status(404).json({ success: false, error: 'Historical data not found' })
  } catch (err) {
    logger.error('❌ [PROMOSPORT] History Error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
})

/**
 * GET /api/promosport/feedback/stats
 * Returns accuracy stats per strategy from historical archive
 */
router.get('/feedback/stats', async (req, res) => {
  try {
    const db = new Database(ARCHIVE_PATH);
    
    const totalMatches = db.prepare(`SELECT COUNT(*) as c FROM promosport_archive`).get();
    const finishedMatches = db.prepare(`SELECT COUNT(*) as c FROM promosport_archive WHERE is_finished = 1`).get();
    const pendingMatches = db.prepare(`SELECT COUNT(*) as c FROM promosport_archive WHERE is_finished = 0 OR result IS NULL`).get();
    const concoursCount = db.prepare(`SELECT COUNT(DISTINCT concours) as c FROM promosport_archive`).get();
    
    // Crowd accuracy stats
    const crowdStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN 
          (CASE 
            WHEN vote_home >= vote_draw AND vote_home >= vote_away THEN '1'
            WHEN vote_draw >= vote_home AND vote_draw >= vote_away THEN 'X'
            ELSE '2'
          END) = result THEN 1 ELSE 0 END
        ) as correct
      FROM promosport_archive 
      WHERE result IS NOT NULL AND vote_home IS NOT NULL AND is_finished = 1
    `).get();

    // Per-confidence-bin crowd accuracy
    const byConfidence = db.prepare(`
      SELECT 
        CAST(ROUND(maxVote / 10) * 10 AS INTEGER) as bin,
        COUNT(*) as total,
        SUM(CASE WHEN crowdFav = result THEN 1 ELSE 0 END) as correct
      FROM (
        SELECT 
          result,
          MAX(vote_home, vote_draw, vote_away) as maxVote,
          (CASE 
            WHEN vote_home >= vote_draw AND vote_home >= vote_away THEN '1'
            WHEN vote_draw >= vote_home AND vote_draw >= vote_away THEN 'X'
            ELSE '2'
          END) as crowdFav
        FROM promosport_archive 
        WHERE result IS NOT NULL AND vote_home IS NOT NULL AND is_finished = 1
      ) GROUP BY bin ORDER BY bin
    `).all();

    db.close();

    res.json({
      success: true,
      totalMatches: totalMatches.c,
      finishedMatches: finishedMatches.c,
      pendingMatches: pendingMatches.c,
      concoursCount: concoursCount.c,
      crowdAccuracy: crowdStats.total > 0 ? +(crowdStats.correct / crowdStats.total * 100).toFixed(1) : 0,
      crowdTotal: crowdStats.total,
      crowdCorrect: crowdStats.correct,
      byConfidence: byConfidence.map(b => ({
        bin: `${b.bin}-${b.bin + 9}%`,
        total: b.total,
        correct: b.correct,
        accuracy: b.total > 0 ? +(b.correct / b.total * 100).toFixed(1) : 0
      })),
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    logger.error('[FEEDBACK] Stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/promosport/accuracy/:concours
 * Compare predictions vs actual results for a specific concours.
 */
router.get('/accuracy/:concours', async (req, res) => {
  try {
    const result = promosportResultService.computeAccuracy(req.params.concours);
    if (!result) return res.status(404).json({ success: false, error: 'Aucune donnée trouvée' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/promosport/accuracy
 * Overall accuracy stats across all concours with predictions.
 */
router.get('/accuracy', async (req, res) => {
  try {
    const stats = promosportResultService.getOverallStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/promosport/check-results/:concours
 * Manually trigger result check + fetch for a concours.
 */
router.post('/check-results/:concours', async (req, res) => {
  try {
    const results = await promosportResultService.checkAndFetchResults(req.params.concours);
    if (!results) return res.json({ success: true, message: 'Pas encore de résultats disponibles' });
    res.json({ success: true, matches: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/promosport/gold-coupon
 * Generate a single Gold Coupon (6 doubles, 7 singles).
 */
router.get('/gold-coupon', async (req, res) => {
  try {
    const speedCache = require('../core/speedCache');
    const { scrapePromosport } = require('../core/promosport_scraper');
    const { generatePromosportGrids, generateGoldCoupon } = require('../core/promosport_engine');

    let scrapedMatches = speedCache.get('promosport_matches');
    if (!scrapedMatches) {
      scrapedMatches = await scrapePromosport();
      if (scrapedMatches && scrapedMatches.length > 0) speedCache.set('promosport_matches', scrapedMatches, 300);
    }
    if (!scrapedMatches || scrapedMatches.length === 0) {
      return res.status(503).json({ success: false, error: 'Aucune donnée disponible' });
    }

    const grids = await generatePromosportGrids(scrapedMatches, [6, 6, 6, 6]);
    if (!grids || grids.length === 0) throw new Error("Grid generation failed");

    const coupon = generateGoldCoupon(grids[0].matches.map((m, i) => ({
      ...m, id: i + 1, homeTeam: m.home, awayTeam: m.away,
      homeWinProbability: m.crowdP1, awayWinProbability: m.crowdP2, drawProbability: m.px
    })));

    res.json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;