/**
 * oddsService.js
 * ─────────────────────────────────────────────────────────────
 * Fetches real 1X2 market odds directly from Sofascore's API.
 * Caches results per match for 15 minutes to avoid rate limits.
 * ─────────────────────────────────────────────────────────────
 */

// Using native global fetch (integrated in Node.js >= 18)
const { getRandomUserAgent } = require('../../SofascoreScraping/src/apiClient')
let scraperProxy = null
try {
  scraperProxy = require('../../services/scraperProxy')
} catch (e) {
  // Optional: only used if ScraperAPI is configured
}

const SOFA_API = 'https://www.sofascore.com/api/v1'
const SOFA_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.sofascore.com/',
  Origin: 'https://www.sofascore.com',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
}

// ── 15-minute in-memory cache ──────────────────────────────────
const oddsCache = new Map()
const CACHE_TTL_MS = 15 * 60 * 1000

function getCached(matchId) {
  const entry = oddsCache.get(matchId)
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data
  oddsCache.delete(matchId)
  return null
}

function setCache(matchId, data) {
  oddsCache.set(matchId, { data, ts: Date.now() })
}

// ── Sofascore market IDs (validés sur 3 eventIds réels, mai 2026) ─────
// Mapping stable confirmé via probe_sofa_markets.py :
//   mid=1  Full-time 1X2          (choices 1/X/2)
//   mid=3  1st half 1X2            (choices 1/X/2, PAS over/under)
//   mid=5  Both teams to score     (choices Yes/No)
//   mid=9  Match goals (OU)        (un bloc par choiceGroup : 0.5, 1.5, 2.5, ...)
//   mid=20 Total Cards             (un bloc par choiceGroup)
//   mid=21 Corners 2-Way           (un bloc par choiceGroup, ex 9.5 ou 10.5)
//   mid=6  First team to score
//   mid=17 Asian handicap
//   mid=2  Double chance
//   mid=4  Draw no bet
// HT Over/Under et HT BTTS : NON DISPONIBLES dans l'API Sofascore gratuite 2026
// (aucun endpoint /odds/2/all, /odds/HT/all, etc. — tous 404). Le moteur garde
// donc les valeurs par défaut documentées (1.5) avec log d'avertissement.
const CORNERS_MARKET_ID = 21

// Fallback transport : le fetch natif Node est bloqué par Sofascore (403 TLS).
// SofascoreBypass spawn `scripts/sofascore_bypass.py` via curl_cffi (fingerprints
// navigateur) et renvoie {home, draw, away, over25, under25, btts_yes, btts_no,
// corner_line, corner_over, corner_under}. Utilisé si le chemin direct échoue.
let bypass = null
try {
  bypass = require('../../services/scrapers/SofascoreBypass')
} catch (e) {
  // Optionnel : prod Render sans venv Python -> chemin direct seul
}

/**
 * Normalise la sortie du bypass Python vers le format getLiveOdds.
 */
function _fromBypass(odds) {
  if (!odds) return null
  const out = {
    home: odds.home ?? null,
    draw: odds.draw ?? null,
    away: odds.away ?? null,
    corner_over: odds.corner_over ?? null,
    corner_under: odds.corner_under ?? null,
    corner_line: odds.corner_line ?? null,
    ht_over: null,
    ht_under: null,
    ht_over15: null,
    ht_btts: null,
  }
  if (!out.home || !out.away) return null
  return out
}

// ── Core fetch ──────────────────────────────────────────────────
/**
 * getLiveOdds(matchId)
 * Returns: { home, draw, away, corner_over, corner_under, corner_line,
 *            ht_over, ht_under, ht_over15, ht_btts } or null on failure.
 *
 * Transport : fetch natif Node (rapide) ; en cas d'échec (403 Sofascore),
 * fallback SofascoreBypass (curl_cffi Python). Même payload /odds/1/all :
 * 1X2 = marketId 1, Corners = marketId 21 (choiceGroup = ligne principale).
 * HT Over/Under et HT BTTS ne sont PAS servis par l'API Sofascore gratuite
 * (validé 2026-05 : tous endpoints /odds/{2,HT,...}/all = 404) -> toujours null.
 */
async function getLiveOdds(matchId) {
  if (!matchId) return null

  const cached = getCached(matchId)
  if (cached) return cached

  // ── Chemin direct ──
  try {
    const url = `${SOFA_API}/event/${matchId}/odds/1/all`
    const res = await fetch(url, {
      headers: {
        ...SOFA_HEADERS,
        'User-Agent': getRandomUserAgent(),
      },
      method: 'GET',
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const markets = data?.markets
    if (!markets || !Array.isArray(markets)) {
      throw new Error('No markets found')
    }

    // Standard Market ID for 1X2 in Sofascore is 1
    const market1x2 =
      markets.find((m) => m.marketId === 1) ||
      markets.find((m) => (m.marketName || '').toLowerCase().includes('result')) ||
      markets[0]

    if (!market1x2?.choices) {
      throw new Error('No choices in market')
    }

    const odds = {
      home: null,
      draw: null,
      away: null,
      corner_over: null,
      corner_under: null,
      corner_line: null,
      ht_over: null,
      ht_under: null,
      ht_over15: null,
      ht_btts: null,
    }

    const parseSofaOdds = (choice) => {
      if (!choice) return null

      // Prefer decimalValue if provided
      if (choice.decimalValue) return parseFloat(choice.decimalValue)

      // Fractional conversion: (num/den) + 1
      const raw = choice.fractionalValue
      if (typeof raw === 'string' && raw.includes('/')) {
        const [num, den] = raw.split('/')
        const val = parseFloat(num) / parseFloat(den) + 1
        return parseFloat(val.toFixed(3))
      }
      return parseFloat(raw)
    }

    for (const choice of market1x2.choices) {
      const name = (choice.name || '').toLowerCase()
      const val = parseSofaOdds(choice)
      if (!val || val <= 1) continue

      if (name === '1' || name === 'home' || choice.sourceId === '1') odds.home = val
      else if (name === 'x' || name === 'draw' || choice.sourceId === '2') odds.draw = val
      else if (name === '2' || name === 'away' || choice.sourceId === '3') odds.away = val
    }

    if (!odds.home || !odds.away) {
      throw new Error(`Incomplete 1X2: ${JSON.stringify(odds)}`)
    }

    // Corners (marketId=21) : un seul appel, choiceGroup = ligne principale
    const cornerBlocks = markets.filter((m) => m.marketId === CORNERS_MARKET_ID)
    if (cornerBlocks.length) {
      const sorted = cornerBlocks
        .map((b) => ({ b, cg: parseFloat(b.choiceGroup) }))
        .filter((x) => !isNaN(x.cg))
        .sort((a, b) => a.cg - b.cg)
      const chosen = sorted[0]?.b || cornerBlocks[0]
      if (chosen?.choices) {
        let overVal = null
        let underVal = null
        for (const c of chosen.choices) {
          const nm = (c.name || '').toLowerCase()
          const v = parseSofaOdds(c)
          if (!v || v <= 1) continue
          if (nm.startsWith('over')) overVal = v
          else if (nm.startsWith('under')) underVal = v
        }
        odds.corner_line = sorted[0]?.cg ?? null
        odds.corner_over = overVal
        odds.corner_under = underVal
      }
    }

    setCache(matchId, odds)
    return odds
  } catch (err) {
    console.error(`[OddsService] Direct fetch failed for ${matchId}: ${err.message}`)
  }

  // ── Fallback bypass (curl_cffi Python) ──
  if (bypass && typeof bypass.getOdds === 'function') {
    try {
      const raw = await bypass.getOdds(String(matchId))
      const odds = _fromBypass(raw)
      if (odds) {
        setCache(matchId, odds)
        return odds
      }
    } catch (e) {
      console.error(`[OddsService] Bypass failed for ${matchId}: ${e.message}`)
    }
  }
  return null
}

module.exports = { getLiveOdds, CORNERS_MARKET_ID }
