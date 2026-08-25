// betexplorerLive.js — Scrape des cotes LIVE (1X2 / O-U / BTTS) via puppeteer-extra + stealth.
// 100% gratuit, local. Aucune clé API. Aucun Chromium dans l'image Docker (usage local uniquement).
//
// Source: BetExplorer (cotes encodées en SVG path style="transform: translate(Xpx, Ypx)").
// Anti-détection: puppeteer-extra-plugin-stealth + délais humanisés.
// Cache: data/odds_cache.json, TTL 1h pour éviter le sur-requêtage.
//
// Usage:
//   node scripts/betexplorerLive.js            # scrape tous les matchs de data/today_matches.json
//   HEADFUL=1 node scripts/betexplorerLive.js  # mode visible (dev) pour ajuster les sélecteurs
//
// Entrée (data/today_matches.json) générée par services/soccerdataService.py:
//   [{ id, home, away, league, country, betexplorerUrl? }, ...]

const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-extra')
const Stealth = require('puppeteer-extra-plugin-stealth')

puppeteer.use(Stealth())

const BASE = path.join(__dirname, '..')
const DATA = path.join(BASE, 'data')
const MATCHES_PATH = process.env.MATCHES_FILE
  ? path.resolve(process.env.MATCHES_FILE)
  : path.join(DATA, 'today_matches.json')
const CACHE_PATH = path.join(DATA, 'odds_cache.json')
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 heure

const HEADFUL = !!process.env.HEADFUL

// Mapping ligue -> slug BetExplorer (pays/ligue). Fallback slugify générique.
const LEAGUE_SLUGS = {
  'england-premier-league': 'england/premier-league',
  'eng-premier-league': 'england/premier-league',
  'england-championship': 'england/championship',
  'spain-la-liga': 'spain/la-liga',
  'esp-la-liga': 'spain/la-liga',
  'spain-primera-division': 'spain/la-liga',
  'germany-bundesliga': 'germany/bundesliga',
  'ger-bundesliga': 'germany/bundesliga',
  'italy-serie-a': 'italy/serie-a',
  'ita-serie-a': 'italy/serie-a',
  'france-ligue-1': 'france/ligue-1',
  'fra-ligue-1': 'france/ligue-1',
  'italy-serie-b': 'italy/serie-b',
  'germany-bundesliga-2': 'germany/2-bundesliga',
  'netherlands-eredivisie': 'netherlands/eredivisie',
  'portugal-primeira-liga': 'portugal/primeira-liga',
  'turkey-super-lig': 'turkey/super-lig',
  'usa-mls': 'usa/mls',
  'tunisia-ligue-professionnelle-1': 'tunisia/ligue-1',
}

function leagueSlug(league) {
  if (LEAGUE_SLUGS[league]) return LEAGUE_SLUGS[league]
  const slug = String(league || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug
}

function slugifyTeam(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loadJson(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (_) {}
  return fallback
}

function loadCache() {
  return loadJson(CACHE_PATH, {})
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
  } catch (e) {
    console.error('[BE] cache write err', e.message)
  }
}

// Extrait les cotes 1X2 du vrai tableau bookmakers (section "Odds Comparison"),
// en excluant le tableau H2H (qui contient aussi des .table-main__odd).
function extractOddsText(page) {
  return page.evaluate(() => {
    // 1) ferme le popup de verification d'age si present
    const els = Array.from(document.querySelectorAll('button, a, input'))
    const yes = els.find((e) => /yes|confirm|continue|ok|sim|entrar|18/i.test(e.textContent || e.value || ''))
    if (yes) yes.click()
    // 2) cible la section Odds Comparison (contient un bookmaker avec cotes)
    // on exclut la section H2H (head-to-head) qui contient aussi des cotes historiques
    const all = Array.from(document.querySelectorAll('div, section'))
    const oddsSection = all.find(
      (d) =>
        /odds comparison/i.test(d.textContent) &&
        d.querySelectorAll('[class*="bookmaker-logo"], [data-bid]').length > 0 &&
        !/head-to-head/.test(d.className)
    )
    if (!oddsSection) return []
    // 3) premiere ligne bookmaker = tr/div avec un logo bookmaker reel + 3 cotes decimales
    const rows = Array.from(oddsSection.querySelectorAll('[class*="row"], tr'))
    const firstBookRow = rows.find((r) => {
      if (/head-to-head/.test(r.className)) return false
      const hasBook = r.querySelector('[class*="bookmaker-logo"], [data-bid]')
      const nums = Array.from(r.querySelectorAll('a, span, div'))
        .map((e) => (e.textContent || '').trim())
        .filter((t) => /^\d+\.\d+$/.test(t))
      return hasBook && nums.length >= 3
    })
    if (!firstBookRow) return []
    const nums = Array.from(firstBookRow.querySelectorAll('a, span, div'))
      .map((e) => (e.textContent || '').trim())
      .filter((t) => /^\d+\.\d+$/.test(t))
    return nums.slice(0, 3)
  })
}

// Premier token significatif (ignore united/utd/city/fc/etc.)
function teamToken(name) {
  const stop = ['united', 'utd', 'city', 'fc', 'afc', 'ac', 'sc', 'cf', 'town', 'athletic', 'real', 'club']
  const parts = slugifyTeam(name).split('-').filter((p) => p && !stop.includes(p))
  return parts[0] || slugifyTeam(name).split('-')[0]
}

// Construit un index {slug: url} de tous les matchs d'une ligue (scroll pour lazy load).
async function buildLeagueIndex(page, league) {
  const slug = leagueSlug(league)
  console.log(`[BE] league='${league}' slug='${slug}'`)
  const url = `https://www.betexplorer.com/football/${slug}/fixtures/`
  console.log(`[BE] buildIndex url=${url}`)
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(2500)
  const dbg = await page.evaluate(() => ({
    url: location.href,
    links: document.querySelectorAll('a[href*="/football/"]').length,
    h: document.body.scrollHeight,
  }))
  console.log(`[BE] index debug ${JSON.stringify(dbg)}`)
  const h0 = await page.evaluate(() => document.body.scrollHeight)
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await sleep(800)
  }
  const h1 = await page.evaluate(() => document.body.scrollHeight)
  console.log(`[BE] index scrollHeight ${h0} -> ${h1}`)
  await sleep(2000)
  const idx = await page.evaluate(() => {
    const map = {}
    document.querySelectorAll('a[href*="/football/"]').forEach((el) => {
      const href = el.getAttribute('href') || ''
      const m = href.match(/\/football\/[^\/]+\/[^\/]+\/([^\/]+)\/[^\/]+\/$/)
      if (m) map[m[1]] = href
    })
    return map
  })
  return idx
}

// Retrouve l'URL d'un match dans l'index préchargé (tolérant aux abréviations).
function findInIndex(index, home, away) {
  const ht = teamToken(home)
  const at = teamToken(away)
  for (const slug of Object.keys(index)) {
    const s = slug.replace(/-/g, ' ')
    if (s.includes(ht) && s.includes(at)) return `https://www.betexplorer.com${index[slug]}`
  }
  return null
}

async function scrapeMatch(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(2000) // laisse le tableau se rendre
  const oddsText = await extractOddsText(page)
  const dec = oddsText
    .map((t) => parseFloat(t))
    .filter((n) => !isNaN(n) && n > 1.01 && n < 1000)
  // Les 3 premières cotes décimales = 1X2 (home, draw, away) du 1er bookmaker
  if (dec.length < 3) return null
  const [home, draw, away] = dec
  return {
    home: round2(home),
    draw: round2(draw),
    away: round2(away),
    source: 'betexplorer-live',
    scrapedAt: Date.now(),
  }
}

function round2(n) {
  return Math.round((parseFloat(n) + Number.EPSILON) * 100) / 100
}

async function main() {
  const matches = loadJson(MATCHES_PATH, [])
  if (!matches.length) {
    console.log('[BE] aucun match dans', MATCHES_PATH)
    return
  }
  const cache = loadCache()
  const browser = await puppeteer.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  const page = await browser.newPage()

  // Index préchargé par ligue (évite de recharger la page par match)
  const indexes = {}
  async function getIndex(league) {
    if (!indexes[league]) {
      console.log(`[BE] index ligue ${league}...`)
      indexes[league] = await buildLeagueIndex(page, league)
      console.log(`[BE] index ${league}: ${Object.keys(indexes[league]).length} matchs`)
    }
    return indexes[league]
  }

  let done = 0
  for (const m of matches) {
    const key = m.id || `${m.home}-${m.away}`
    const cached = cache[key]
    if (cached && cached.scrapedAt && Date.now() - cached.scrapedAt < CACHE_TTL_MS) {
      console.log(`[BE] cache frais ${key}`)
      continue
    }
    let url = m.betexplorerUrl || null
    try {
      if (!url) {
        const idx = await getIndex(m.league)
        url = findInIndex(idx, m.home, m.away)
      }
      if (!url) {
        console.log(`[BE] url introuvable ${key}`)
        continue
      }
      const odds = await scrapeMatch(page, url)
      if (odds) {
        cache[key] = { ...odds, homeTeam: m.home, awayTeam: m.away, league: m.league, url }
        console.log(`[BE] ${key} ->`, JSON.stringify(odds))
        done++
      } else {
        console.log(`[BE] cotes non extraites ${key}`)
      }
    } catch (e) {
      console.log(`[BE] err ${key}:`, e.message)
    }
    await sleep(1200 + Math.floor(Math.random() * 1500)) // délai humanisé
  }

  await browser.close()
  saveCache(cache)
  console.log(`[BE] terminé. ${done} matchs scrapés, cache -> ${CACHE_PATH}`)
}

main().catch((e) => {
  console.error('[BE] fatal', e)
  process.exit(1)
})
