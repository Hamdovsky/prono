const axios = require('axios')
const cheerio = require('cheerio')
const fs = require('fs')
const path = require('path')
const logger = require('../core/logger')

const PUSHED_TTL = 6 * 60 * 60 * 1000
const PUSHED_FILE = path.join(process.cwd(), 'data', 'fbref_team_xg.json')

const LEAGUES = {
  // id = fbref competition id, name = URL slug. Majeures d'abord (les matches
  // à favori net) puis ligues secondaires. Chaque id correspond à "The Stats".
  PL: { id: 9, name: 'Premier-League' },
  LA_LIGA: { id: 12, name: 'La-Liga' },
  SERIE_A: { id: 11, name: 'Serie-A' },
  BUNDESLIGA: { id: 20, name: 'Bundesliga' },
  LIGUE_1: { id: 13, name: 'Ligue-1' },
  CHAMPIONSHIP: { id: 10, name: 'Championship' },
  EREDIVISIE: { id: 23, name: 'Eredivisie' },
  LIGA_PORTUGAL: { id: 32, name: 'Primeira-Liga' },
  MLS: { id: 22, name: 'Major-League-Soccer' },
  BRASILEIRAO: { id: 24, name: 'Serie-A' },
  LIGUE_2: { id: 131, name: 'Ligue-2' },
  CHAMPIONS_LEAGUE: { id: 8, name: 'Champions-League' },
  EUROPA_LEAGUE: { id: 19, name: 'Europa-League' },
  SERIE_B: { id: 18, name: 'Serie-B' },
  BUNDESLIGA_2: { id: 33, name: 'Bundesliga-2' },
  LA_LIGA_2: { id: 17, name: 'Segunda-Division' },
  SCOTTISH_PREMIERSHIP: { id: 40, name: 'Scottish-Premiership' },
  J_LEAGUE: { id: 68, name: 'J1-League' },
  K_LEAGUE_1: { id: 86, name: 'K-League-1' },
  ALLSVENSKAN: { id: 31, name: 'Allsvenskan' },
  ELITESERIEN: { id: 28, name: 'Eliteserien' },
  SUPER_LIG: { id: 71, name: 'Super-Lig' },
  LIGA_MX: { id: 14, name: 'Liga-MX' },
  ARG_PRIMERA: { id: 21, name: 'Primera-Division' },
  CHINA_SUPER: { id: 70, name: 'Chinese-Super-League' },
}

const CACHE_TTL = 60 * 60 * 1000
const cache = { teamStats: new Map(), matchStats: new Map() }
const BASE = 'https://fbref.com'

// User-Agents tournées pour atténuer le blocage Cloudflare (403/429).
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
]
let _uaIndex = 0
const _nextUA = () => USER_AGENTS[(_uaIndex = (_uaIndex + 1) % USER_AGENTS.length)]

class FbrefService {
  constructor() {
    this.enabled = true
    this._pushedCache = null
    this.leagues = LEAGUES // exposed for local scraper / tooling
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

  async fetchPage(url, retries = 2) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        // Backoff sur retry (lundi antivirus / réponse 403/429 Cloudflare)
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
      try {
        const res = await axios.get(url, {
          headers: {
            'User-Agent': _nextUA(),
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
          },
          timeout: 20000,
        })
        if (res.status === 200) return cheerio.load(res.data)
        lastErr = new Error(`HTTP ${res.status} for ${url}`)
      } catch (e) {
        lastErr = e
        // Ne pas re-scraper si c'est une erreur réseau permanente (430/403)
        if (e.response && [403, 429].includes(e.response.status)) {
          logger.warn(`[FBREF] blocked (${e.response.status}) on ${url}, retry ${attempt + 1}`)
          continue
        }
        logger.warn(`[FBREF] fetch error ${url}: ${e.message}`)
      }
    }
    throw lastErr
  }

  _parseLeagueTable($) {
    const stats = []
    // Standard stats table (goals, xG, assists, xAG). fbref change l'id du
    // tableau selon la saison/compétition (#stats_standard, #stats_standard_9...),
    // donc on cherche le PREMIER tableau contenant un th[data-stat="team"].
    let table = $('#stats_standard')
    if (!table.length) {
      table = $('table[id^="stats_standard"]').first()
    }
    if (!table.length) return stats

    const rows = table.find('tbody tr')
    rows.each((_, row) => {
      const $row = $(row)
      const team = $row.find('th[data-stat="team"] a, th[data-stat="team"]').first().text().trim()
      if (!team) return

      const parseNum = (sel) => {
        const val = $row.find(`td[data-stat="${sel}"]`).first().text().trim()
        const n = parseFloat(val)
        return isNaN(n) ? null : n
      }

      stats.push({
        team,
        matches: parseNum('games'),
        goals: parseNum('goals'),
        xG: parseNum('xg'),
        assists: parseNum('assists'),
        xAG: parseNum('xag'),
        goalsAgainst: parseNum('goals_against'),
        xGA: parseNum('xg_against'),
        shotsOnTarget: parseNum('shots_on_target'),
        shots: parseNum('shots_total'),
        cleanSheets: parseNum('clean_sheets'),
        possession: parseNum('possession'),
        passesCompleted: parseNum('passes_completed'),
        passCompletionPct: parseNum('pass_pct'),
        progressivePasses: parseNum('progressive_passes'),
        progressiveCarries: parseNum('progressive_carries'),
        tackles: parseNum('tackles'),
        interceptions: parseNum('interceptions'),
        blocks: parseNum('blocks'),
      })
    })
    return stats
  }

  async getTeamStats(leagueCode) {
    const league = LEAGUES[leagueCode]
    if (!league) throw new Error(`Unsupported league: ${leagueCode}`)

    const cacheKey = `teamStats:${leagueCode}`
    const cached = this._getCached(cacheKey, cache.teamStats)
    if (cached) return cached

    const url = `${BASE}/en/comps/${league.id}/${league.name}-Stats`
    const $ = await this.fetchPage(url)
    const stats = this._parseLeagueTable($)

    this._setCache(cacheKey, cache.teamStats, stats)
    logger.info(`[FBREF] Fetched ${stats.length} teams for ${leagueCode}`)
    return stats
  }

  async getMatchStats(matchUrl) {
    const cacheKey = `match:${matchUrl}`
    const cached = this._getCached(cacheKey, cache.matchStats)
    if (cached) return cached

    const $ = await this.fetchPage(matchUrl.startsWith('http') ? matchUrl : `${BASE}${matchUrl}`)

    const result = {}

    // Team names
    result.homeTeam = $('#content h1').text().split(' vs ')[0]?.trim() || ''
    result.awayTeam = $('#content h1').text().split(' vs ')[1]?.trim() || ''

    // Score
    const scoreEl = $('.score')
    if (scoreEl.length) {
      const parts = scoreEl.text().trim().split('–')
      result.homeGoals = parseInt(parts[0]) || 0
      result.awayGoals = parseInt(parts[1]) || 0
    }

    // xG from match summary
    const xgEl = $('.xg_summary')
    if (xgEl.length) {
      result.homeXG = parseFloat(xgEl.find('.home_xg').text()) || null
      result.awayXG = parseFloat(xgEl.find('.away_xg').text()) || null
    }

    // Possession
    const possEl = $('#team_stats_possession')
    if (possEl.length) {
      result.homePossession =
        parseFloat(possEl.find('td[data-stat="possession"]').first().text()) || null
      result.awayPossession =
        parseFloat(possEl.find('td[data-stat="possession"]').last().text()) || null
    }

    this._setCache(cacheKey, cache.matchStats, result)
    return result
  }

  // Charge le fichier de xG poussé par le scraper local (avec cache mémoire ~5 min).
  _loadPushedFile() {
    if (this._pushedCache && Date.now() - this._pushedCache.ts < 5 * 60 * 1000) {
      return this._pushedCache.data
    }
    try {
      if (fs.existsSync(PUSHED_FILE)) {
        const data = JSON.parse(fs.readFileSync(PUSHED_FILE, 'utf8'))
        this._pushedCache = { ts: Date.now(), data }
        return data
      }
    } catch (e) {
      logger.warn(`[FBREF] pushed file read failed: ${e.message}`)
    }
    this._pushedCache = { ts: Date.now(), data: null }
    return null
  }

  // Invalide le cache en mémoire du fichier poussé (appelé après un ingest).
  invalidatePushedCache() {
    this._pushedCache = null
  }

  // Fragment-stale heuristic: an unreliable league table (e.g. one-match).
  _isStaleFball(entry) {
    return entry && entry.matches < 3
  }

  // Normalisation légère des noms internes (BSD/oddsAPI) vers fbref :
  // strips accents, ponctuation et formes "better", tout en minuscules
  // espacées, pour le matching fuzzy basé sur le préfixe.
  _normalizeName(name) {
    return String(name || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  // Récupère le { xG, xGA, matches } d'une équipe d'une ligue donnée.
  // Priorité: fichier poussé par le scraper local (data/fbref_team_xg.json, frais)
  // puis scraping réseau (IP résidentielle / fallback).
  async getTeamXG(teamName, leagueCode) {
    // 1. Fichier poussé (fraîcheur ~6h) — évite des appels réseau sur Render
    const file = this._loadPushedFile()
    const pushed = file && file.leagues && file.leagues[leagueCode]
    if (pushed && file.updatedAt && Date.now() - file.updatedAt < PUSHED_TTL) {
      const res = this._matchInArray(pushed.teams || [], teamName)
      if (res) return res
    }
    // 2. Scraping réseau
    const stats = await this.getTeamStats(leagueCode)
    if (!stats || !stats.length) return null
    const viaNetwork = this._matchInArray(stats, teamName)
    if (viaNetwork && this._isStaleFball(viaNetwork)) return null
    return viaNetwork
  }

  _matchInArray(arr, teamName) {
    const q = this._normalizeName(teamName)
    if (!q) return null
    let best = null
    for (const s of arr) {
      const n = this._normalizeName(s.team)
      if (!n) continue
      const words = q.split(' ')
      const matchesPrefix =
        n === q ||
        n.split(' ').slice(0, words.length).join(' ') === words.join(' ') ||
        (words.length >= 2 && n === words.slice(0, 2).join(' '))
      if (matchesPrefix) {
        best = s
        break
      }
    }
    if (!best) {
      for (const s of arr) {
        const n = this._normalizeName(s.team)
        if (n && n.length > 3 && (n.includes(q) || q.startsWith(n))) {
          best = s
          break
        }
      }
    }
    if (!best) return null
    return {
      team: best.team,
      xG: parseFloat(best.xG) || null,
      xGA: parseFloat(best.xGA) || null,
      matches: parseInt(best.matches) || 0,
    }
  }

  // Mappe un nom de ligue libre (match.league) vers un code LEAGUES fbref.
  _matchLeagueCode(leagueName) {
    const l = String(leagueName || '').toLowerCase()
    if (!l) return null
    if (l.includes('championship') && !l.includes('champions league')) return 'CHAMPIONSHIP'
    if (l.includes('eredivisie') || l.includes('netherlands') || l.includes('holland')) return 'EREDIVISIE'
    if (l.includes('primeira') || l.includes('portugal')) return 'LIGA_PORTUGAL'
    if (l.includes('mls') || l.includes('major league soccer')) return 'MLS'
    if (l.includes('brasileir') || l.includes('brazil')) return 'BRASILEIRAO'
    if (l.includes('ligue 1') || l.includes('ligue one') || l.includes('france')) return 'LIGUE_1'
    if (l.includes('ligue 2') || l.includes('france 2')) return 'LIGUE_2'
    if (l.includes('premier league') || (l.includes('england') && !l.includes('championship'))) return 'PL'
    if (l.includes('champions league') || l.includes('uefa champions')) return 'CHAMPIONS_LEAGUE'
    if (l.includes('europa league') || l.includes('uefa europa')) return 'EUROPA_LEAGUE'
    if (l.includes('serie b')) return 'SERIE_B'
    if (l.includes('bundesliga 2') || l.includes('bundesliga two') || l.includes('2. bundesliga')) return 'BUNDESLIGA_2'
    if (l.includes('la liga 2') || l.includes('segunda division') || l.includes('segunda')) return 'LA_LIGA_2'
    if (l.includes('la liga') || l.includes('laliga') || l.includes('spain')) return 'LA_LIGA'
    if (l.includes('serie a') || (l.includes('italy') && !l.includes('serie b'))) return 'SERIE_A'
    if (l.includes('bundesliga') && !l.includes('2')) return 'BUNDESLIGA'
    if (l.includes('scottish premiership') || l.includes('scotland')) return 'SCOTTISH_PREMIERSHIP'
    if (l.includes('j1 league') || l.includes('j.league') || l.includes('japan')) return 'J_LEAGUE'
    if (l.includes('k league 1') || l.includes('k-league') || l.includes('korea')) return 'K_LEAGUE_1'
    if (l.includes('allsvenskan') || l.includes('sweden')) return 'ALLSVENSKAN'
    if (l.includes('eliteserien') || l.includes('norway')) return 'ELITESERIEN'
    if (l.includes('super lig') || l.includes('turkish') || l.includes('turkey')) return 'SUPER_LIG'
    if (l.includes('liga mx') || l.includes('mexico') || l.includes('mexican')) return 'LIGA_MX'
    if (l.includes('primera division') || l.includes('argentina')) return 'ARG_PRIMERA'
    if (l.includes('china') || l.includes('cs') || l.includes('chinese super')) return 'CHINA_SUPER'
    return null
  }

  // Pré-remplit un match avec le xG/xGA fbref des deux équipes (si trouvés).
  // Appelé une fois par match (cache 60 min par ligue → ~1 requête/ligue/cycle).
  async attachMatchXG(match) {
    if (!match || !match.homeTeam || !match.awayTeam) return match
    // Ne pas écraser un xG fiable déjà présent
    if (parseFloat(match.home_xg) > 0.1 && parseFloat(match.away_xg) > 0.1) return match
    const code = this._matchLeagueCode(match.league || match.tournament)
    if (!code) return match
    try {
      const [h, a] = await Promise.all([
        this.getTeamXG(match.homeTeam, code),
        this.getTeamXG(match.awayTeam, code),
      ])
      if (h && h.xG) match.home_xg = h.xG
      if (a && a.xG) match.away_xg = a.xG
      if (h && h.xGA) match.home_xga = h.xGA
      if (a && a.xGA) match.away_xga = a.xGA
      if (h && a) match._xgSource = 'fbref'
    } catch (e) {
      logger.warn(`[FBREF] attachMatchXG skip ${match.id || ''}: ${e.message}`)
    }
    return match
  }
}

module.exports = new FbrefService()
