const axios = require('axios')
const cheerio = require('cheerio')
const logger = require('../core/logger')

const CACHE_TTL = 6 * 60 * 60 * 1000
const cache = { teamValue: new Map(), injuries: new Map(), form: new Map(), coaches: new Map() }
const COACH_CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const BASE = 'https://www.transfermarkt.com'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.transfermarkt.com/',
  DNT: '1',
}

class TransfermarktService {
  constructor() {
    this.enabled = true
  }

  isAvailable() {
    return this.enabled
  }

  _getCached(key, map) {
    const entry = map.get(key)
    if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data
    return null
  }

  _setCache(key, map, data) {
    map.set(key, { ts: Date.now(), data })
  }

  async fetchPage(url) {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 })
    return cheerio.load(res.data)
  }

  async getTeamValue(teamSlug, teamId) {
    const cacheKey = `value:${teamId}`
    const cached = this._getCached(cacheKey, cache.teamValue)
    if (cached) return cached

    const url = `${BASE}/${teamSlug}/startseite/verein/${teamId}`
    const $ = await this.fetchPage(url)

    // E121 : deux markups observes — `.marktwert` (gros clubs) et
    // `a[class*=market-value-wrapper]` (ex. Raja : "€15.82m" + label).
    let raw = $('.marktwert').first().text().trim()
    if (!raw) {
      // E121-bis : le texte plat colle l'unite au label ("€15.82mTotal..."),
      // ce qui fausse le parse d'unite -> on lit la STRUCTURE :
      // <span>€</span>15.82<span>m</span>.
      const wrapHtml = $('[class*="market-value-wrapper"]').first().html() || ''
      let m = /<span[^>]*>€<\/span>\s*([\d.,]+)\s*<span[^>]*>([a-zA-Z]+)<\/span>/.exec(wrapHtml)
      if (m) {
        raw = `€${m[1]}${m[2]}`
      } else {
        const wrap = $('[class*="market-value-wrapper"]').first().text().replace(/\s+/g, ' ').trim()
        const m2 = /€\s*([\d.,]+)\s*([a-zA-Z]{1,3})(?![a-zA-Z])/.exec(wrap)
        if (m2) raw = `€${m2[1]}${m2[2]}`
      }
    }
    const value = parseMarketValue(raw)

    // Form guide (last 5 matches)

    // Form guide (last 5 matches)
    const form = []
    const formEls = $('.rechts .form .svg ')
    if (formEls.length) {
      formEls.each((_, el) => {
        const cls = $(el).attr('class') || ''
        if (cls.includes('sieg')) form.push('W')
        else if (cls.includes('niederlage')) form.push('L')
        else form.push('D')
      })
    }

    const result = { value, form, currency: '€' }
    this._setCache(cacheKey, cache.teamValue, result)
    logger.info(
      `[TRANSFERMARKT] Team value for ${teamSlug}: ${value ? value.toLocaleString() : 'N/A'} €`
    )
    return result
  }

  async getTeamInjuries(teamSlug, teamId) {
    const cacheKey = `injuries:${teamId}`
    const cached = this._getCached(cacheKey, cache.injuries)
    if (cached) return cached

    const url = `${BASE}/${teamSlug}/verletzungen/verein/${teamId}`
    const $ = await this.fetchPage(url)

    const injuries = []
    const rows = $('.table tbody tr')
    rows.each((_, row) => {
      const $row = $(row)
      const name = $row.find('td:nth-child(2) a').text().trim()
      const position = $row.find('td:nth-child(3)').text().trim()
      const injury = $row.find('td:nth-child(4)').text().trim()
      const returnDate = $row.find('td:nth-child(5)').text().trim()
      if (name && injury) {
        injuries.push({ name, position, injury, returnDate })
      }
    })

    this._setCache(cacheKey, cache.injuries, injuries)
    logger.info(`[TRANSFERMARKT] ${injuries.length} injuries for ${teamSlug}`)
    return injuries
  }

  /**
   * Historique des entraîneurs (`mitarbeiterhistorie`) : [{ name, appointed
   * (ISO|null), ended (ISO|null), current (bool), matches, ppg }], le plus
   * récent affiché en premier. Défensif : null si la structure change.
   * Cache 7 jours (un coach change rarement).
   */
  async getManagerHistory(teamSlug, teamId) {
    const cacheKey = `coaches:${teamId}`
    const cached = cache.coaches.get(cacheKey)
    if (cached && Date.now() - cached.ts < COACH_CACHE_TTL) return cached.data

    const url = `${BASE}/${teamSlug}/mitarbeiterhistorie/verein/${teamId}`
    const $ = await this.fetchPage(url)
    const data = parseManagerHistory($)
    if (data) {
      cache.coaches.set(cacheKey, { ts: Date.now(), data })
      logger.info(`[TRANSFERMARKT] ${data.length} coach(es) for ${teamSlug}`)
    }
    return data
  }

  async getFormGuide(teamSlug, teamId) {
    const cacheKey = `form:${teamId}`
    const cached = this._getCached(cacheKey, cache.form)
    if (cached) return cached

    const url = `${BASE}/${teamSlug}/startseite/verein/${teamId}`
    const $ = await this.fetchPage(url)

    const form = []
    const formSvg = $('.form-box .svg ')
    formSvg.each((_, el) => {
      const cls = $(el).attr('class') || ''
      if (cls.includes('win') || cls.includes('sieg')) form.push('W')
      else if (cls.includes('loss') || cls.includes('niederlage')) form.push('L')
      else form.push('D')
    })

    this._setCache(cacheKey, cache.form, form)
    return form
  }
}
/**
 * Parse pur (testable) de la table staff Transfermarkt. Colonnes attendues :
 * Name | Nat. | Appointed | End of time in post | Time in post | Matches | PPG.
 * Lignes parasites (sans nom ou < 3 cellules) ignorées ; doublons
 * nom+nomination dédupliqués ; `current` = pas de date de fin.
 */
function parseManagerHistory($) {
  const tables = $('table.items')
  if (!tables.length) return null
  let table = null
  tables.each((_, t) => {
    if (table) return
    const heads = []
    $(t).find('thead th').each((_, th) => heads.push($(th).text().trim()))
    if (heads.some((h) => /appointed/i.test(h))) table = $(t)
  })
  if (!table) return null
  const out = []
  const seen = new Set()
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr)
    const name = $tr.find('td.hauptlink').first().text().trim().split('\n')[0].trim()
    const cells = []
    $tr.find('td.zentriert').each((_, td) => cells.push($(td).text().trim()))
    if (!name || cells.length < 3) return
    const appointed = parseDmY(cells[1])
    const ended = parseDmY(cells[2])
    const key = `${name}|${appointed || cells[1] || ''}`
    if (seen.has(key)) return
    seen.add(key)
    const matches = parseInt((cells[cells.length - 2] || '').replace(/\D/g, ''), 10)
    const ppg = parseFloat((cells[cells.length - 1] || '').replace(',', '.'))
    out.push({
      name,
      appointed,
      ended,
      current: !ended,
      matches: Number.isFinite(matches) ? matches : null,
      ppg: Number.isFinite(ppg) ? ppg : null,
    })
  })
  return out
}

/** JJ/MM/AAAA -> AAAA-MM-JJ, null si absent/invalide (tirets, futurs vides). */
function parseDmY(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim())
  if (!m) return null
  const [, dd, mm, yyyy] = m
  if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31) return null
  return `${yyyy}-${mm}-${dd}`
}

/**
 * "€15.82m" / "€1.50bn" / "€2,30Mrd" -> euros (number) ou null.
 * Unites : k=1e3, m=1e6, bn|b|Mrd=1e9. Jamais d'invention : null si illisible.
 */
function parseMarketValue(raw) {
  const m = /€\s*([\d.,]+)\s*([a-zA-Z]*)/.exec(String(raw || ''))
  if (!m) return null
  const num = parseFloat(m[1].replace(',', '.'))
  if (!Number.isFinite(num)) return null
  const unit = (m[2] || '').toLowerCase()
  if (unit === '') return num * 1e6 // format historique sans unite explicite
  if (unit.startsWith('k')) return num * 1e3
  if (unit === 'm') return num * 1e6
  if (unit === 'b' || unit.startsWith('bn') || unit.startsWith('mrd')) return num * 1e9
  return null // unite inconnue : pas d'invention
}

module.exports = new TransfermarktService()
module.exports.parseManagerHistory = parseManagerHistory
module.exports.parseDmY = parseDmY
module.exports.parseMarketValue = parseMarketValue
