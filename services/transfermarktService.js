const axios = require('axios')
const cheerio = require('cheerio')
const logger = require('../core/logger')

const CACHE_TTL = 6 * 60 * 60 * 1000
const cache = { teamValue: new Map(), injuries: new Map(), form: new Map() }
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

    let value = null
    // Extract from the market value widget
    const valueEl = $('.marktwert').first()
    if (valueEl.length) {
      const raw = valueEl.text().trim()
      const num = raw.replace(/[^0-9,.]/g, '').replace(',', '.')
      value = parseFloat(num) * 1_000_000
      if (raw.includes('Mrd')) value *= 1000
    }

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

module.exports = new TransfermarktService()
