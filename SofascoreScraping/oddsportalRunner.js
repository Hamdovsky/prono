/**
 * oddsportalRunner.js — E48 sous-process isole pour Playwright/OddsPortal.
 *
 * Pourquoi ce fichier vit ICI (et pas dans services/) : Node resout `require('playwright')`
 * en remontant depuis le REPERTOIRE DU SCRIPT, pas depuis `cwd`. Ce fichier situe sous
 * SofascoreScraping/ trouve donc SofascoreScraping/node_modules/playwright sans NODE_PATH,
 * sans cwd special, ET sans jamais toucher le package.json principal ni le Dockerfile
 * (isolation structurelle : Chromium ne peut pas fuiter dans l'image de prod).
 *
 * Protocol IPC avec le parent (services/oddsportalClient.js) : NDJSON sur pipes.
 *   Parent -> Enfant :  {"op":"fetchLeague","slug":"italy/serie-d-group-d"}\n
 *                       {"op":"close"}\n
 *   Enfant -> Parent :  {"ok":true,"op":"fetchLeague","result":{...}}\n
 *                       {"ok":true,"op":"closed"}\n
 * Pas de fichier temporaire : le pipe se ferme proprement quand le parent meurt
 * (close sur stdin -> browser.close -> exit).
 */
const readline = require('readline')
const { chromium } = require('playwright')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const BASE = 'https://www.oddsportal.com/football/'

const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ODDSPORTAL_CONCURRENCY || 3)))
const GAP_MS = Number(process.env.ODDSPORTAL_GAP_MS || 1200)
const NAV_TIMEOUT_MS = Number(process.env.ODDSPORTAL_NAV_TIMEOUT_MS || 45000)
const RENDER_WAIT_MS = Number(process.env.ODDSPORTAL_RENDER_WAIT_MS || 6000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let _browser = null
let _slots = []

function out(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch (_) {}
}

// Pool de pages : acquire() bloque jusqu'a disponibilite, release() rend au pool.
// Permet de traiter N matchs en parallele (N = CONCURRENCY) sur des pages distinctes.
class PagePool {
  constructor(pages) { this.free = [...pages]; this.waiters = [] }
  acquire() {
    if (this.free.length) return Promise.resolve(this.free.shift())
    return new Promise((r) => this.waiters.push(r))
  }
  release(p) {
    if (this.waiters.length) this.waiters.shift()(p)
    else this.free.push(p)
  }
}

let _pool = null

async function ensureBrowser() {
  if (_browser) return
  _browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  _slots = []
  for (let i = 0; i < CONCURRENCY; i++) {
    const ctx = await _browser.newContext({
      userAgent: UA,
      locale: 'en-GB',
      viewport: { width: 1400, height: 1000 },
    })
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    _slots.push(await ctx.newPage())
  }
  _pool = new PagePool(_slots)
}

async function closeBrowser() {
  if (_browser) { try { await _browser.close() } catch (_) {} }
  _browser = null
  _slots = []
  _pool = null
}

async function extract1x2(page) {
  return page.evaluate(() => {
    const tr = [...document.querySelectorAll('tr')].find((r) => /1xBet|bet365|22Bet/i.test(r.innerText))
    if (!tr) return null
    const t = (tr.innerText || '').replace(/\s+/g, ' ').trim()
    const m = t.match(/(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d{2})/)
    return m ? { home: Number(m[1]), draw: Number(m[2]), away: Number(m[3]) } : null
  }).catch(() => null)
}

async function clickOverUnder(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].filter((e) => {
      const own = [...e.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join('')
      return own === 'Over/Under'
    })
    if (!els.length) return false
    const btn = els[0].closest('button,a,[role="tab"]') || els[0]
    btn.click()
    return true
  }).catch(() => false)
}

async function extractOverUnder(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('table tr')]
    const parsed = []
    rows.forEach((r) => {
      const t = (r.innerText || '').replace(/\s+/g, ' ').trim()
      const m = t.match(/Over\/Under\s*\+?(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d+)?/)
      if (m) parsed.push({ line: m[1], bookies: Number(m[2]), over: Number(m[3]), under: Number(m[4]), payout: m[5] ? Number(m[5]) : null })
    })
    const l25 = parsed.find((o) => o.line === '2.5')
    return { lines: parsed, line25: l25 || null }
  }).catch(() => ({ lines: [], line25: null }))
}

async function fetchLeague(slug) {
  const clean = String(slug || '').replace(/^\/+|\/+$/g, '')
  const url = BASE + clean + '/'
  const stats = { slug: clean, matches: [], noOddsPublished: 0, errors: 0, ms: 0 }
  const t0 = Date.now()

  const page = await _pool.acquire()
  let links = []
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForTimeout(RENDER_WAIT_MS)
    links = await page.evaluate(() => {
      const out = []
      const seen = new Set()
      document.querySelectorAll('a[href*="/h2h/"]').forEach((a) => {
        const href = a.getAttribute('href') || ''
        const txt = (a.innerText || '').trim().replace(/\s+/g, ' ')
        if (!href || !txt || txt.length < 3 || seen.has(href)) return
        seen.add(href)
        out.push({ href: href.split('#')[0], name: txt })
      })
      return out
    })
  } catch (e) {
    stats.errors++
    stats.error_message = e.message
    _pool.release(page)
    stats.ms = Date.now() - t0
    return stats
  } finally {
    if (_pool.free.indexOf(page) === -1) _pool.release(page)
  }

  const processLink = async (l) => {
    const p = await _pool.acquire()
    try {
      await p.goto('https://www.oddsportal.com' + l.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
      await p.waitForTimeout(RENDER_WAIT_MS)
      const x12 = await extract1x2(p)
      const clicked = await clickOverUnder(p)
      if (clicked) await p.waitForTimeout(RENDER_WAIT_MS)
      const ou = await extractOverUnder(p)
      const has12 = !!(x12 && x12.home && x12.draw && x12.away)
      const hasOU = !!(ou.line25 && ou.line25.over && ou.line25.under)
      if (!has12 && !hasOU) { stats.noOddsPublished++; return }
      stats.matches.push({
        label: l.name,
        href: l.href,
        odds_home: has12 ? x12.home : null,
        odds_draw: has12 ? x12.draw : null,
        odds_away: has12 ? x12.away : null,
        odds_over25: hasOU ? ou.line25.over : null,
        odds_under25: hasOU ? ou.line25.under : null,
      })
      if (GAP_MS) await sleep(GAP_MS)
    } catch (_) {
      stats.errors++
    } finally {
      _pool.release(p)
    }
  }

  await Promise.all(links.map((l) => processLink(l)))

  stats.ms = Date.now() - t0
  return stats
}

async function handle(msg) {
  switch (msg && msg.op) {
    case 'ping':
      out({ ok: true, op: 'pong' })
      return
    case 'fetchLeague': {
      await ensureBrowser()
      const r = await fetchLeague(msg.slug)
      out({ ok: true, op: 'fetchLeague', result: r })
      return
    }
    case 'close':
      await closeBrowser()
      out({ ok: true, op: 'closed' })
      process.exit(0)
      return
    default:
      out({ ok: false, error: 'unknown op: ' + String(msg && msg.op) })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try { msg = JSON.parse(s) } catch (_) { out({ ok: false, error: 'bad json' }); return }
  handle(msg).catch((e) => out({ ok: false, error: e.message }))
})
rl.on('close', async () => { await closeBrowser(); process.exit(0) })
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0) })
process.on('SIGINT', async () => { await closeBrowser(); process.exit(0) })

module.exports = { fetchLeague, extractOverUnder, extract1x2, clickOverUnder }
