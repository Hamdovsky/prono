const axios = require('axios')
const Parser = require('rss-parser')
const retry = require('async-retry')
const logger = require('../core/logger')
const { pooledConfig } = require('../core/networkConfig')
const parser = new Parser()

class GoalNewsService {
  constructor() {
    this.sources = {
      en: [
        'https://www.skysports.com/rss/11095',
        'https://feeds.bbci.co.uk/sport/football/rss.xml',
        'https://www.espn.com/espn/rss/soccer/news',
        'https://www.theguardian.com/football/rss',
      ],
      ar: [],
      fr: [
        'https://www.lequipe.fr/rss/actu_rss_Football.xml',
        'https://www.france24.com/fr/sport/rss',
      ],
      br: [
        'https://www.espn.com/espn/rss/soccer/news',
      ],
    }

    this.impactKeywords = {
      negative: [
        'injury', 'injured', 'broken', 'suspension', 'suspended',
        'doubtful', 'misses', 'absent', 'rested', 'crisis', 'defeat', 'out for',
        'blessure', 'suspendu', 'lesao', 'desfalque',
      ],
      positive: [
        'returns', 'fit', 'back', 'recovered', 'available', 'starts', 'boost',
        'signing', 'win', 'confident',
        'retour', 'disponible', 'refoco', 'confiante',
      ],
    }
  }

  normalize(name) {
    if (!name) return ''
    const n = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\((.*?)\)/g, '')
      .trim()
    const noise = /\b(fc|club|ca|pfk|clube|sc|as|sd|ud|cd|juventude|esporte|recreativo)\b/gi
    return n.replace(noise, '').replace(/\s+/g, ' ').trim()
  }

  buildGoogleNewsUrl(query, lang) {
    if (lang === 'ar') {
      return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+team+match&hl=ar&gl=SA&ceid=SA:ar`
    }
    return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+injury+team&hl=en&gl=US&ceid=US:en`
  }

  async fetchFromUrl(teamName, url) {
    try {
      return await retry(async () => {
        const response = await axios.get(url, {
          ...pooledConfig,
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
          },
        })
        const feed = await parser.parseString(response.data)
        const normName = this.normalize(teamName)
        const teamArticles = feed.items.filter((item) => {
          const text = (item.title + ' ' + (item.contentSnippet || '')).toLowerCase()
          const normText = this.normalize(text)
          return normText.includes(normName)
        })
        if (teamArticles.length > 0) {
          return { articles: teamArticles }
        }
        return null
      }, { retries: 1, minTimeout: 1000 })
    } catch (e) {
      return null
    }
  }

  async fetchFromGoogleNews(teamName, lang = 'ar') {
    try {
      const query = `${teamName} team`
      const url = this.buildGoogleNewsUrl(query, lang)
      const response = await axios.get(url, {
        ...pooledConfig,
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36',
        },
      })
      const feed = await parser.parseString(response.data)
      const normName = this.normalize(teamName)
      const teamArticles = feed.items.filter((item) => {
        const text = (item.title + ' ' + (item.contentSnippet || '')).toLowerCase()
        const normText = this.normalize(text)
        return normText.includes(normName)
      })
      if (teamArticles.length > 0) {
        return { articles: teamArticles }
      }
      return null
    } catch (e) {
      return null
    }
  }

  async getTeamNews(teamName, countryHint = '') {
    try {
      const c = (countryHint || '').toLowerCase()
      let langOrder = ['en']

      if (c.includes('brazil') || c.includes('portugal')) {
        langOrder = ['en']
      } else if (c.includes('france') || c.includes('senegal') || c.includes('algeria') || c.includes('morocco')) {
        langOrder = ['fr', 'en', 'ar']
      } else if (c.includes('arab') || c.includes('egypt') || c.includes('tunisia') || c.includes('qatar') || c.includes('saudi')) {
        langOrder = ['ar', 'en']
      }

      const uniqueLangs = [...new Set([...langOrder, 'en', 'ar', 'fr'])]

      let bestResult = null
      let sourceName = ''

      for (const lang of uniqueLangs) {
        const urls = this.sources[lang] || []
        for (const url of urls) {
          const res = await this.fetchFromUrl(teamName, url)
          if (res) {
            bestResult = res
            sourceName = url.includes('bbc') ? 'BBC' : url.includes('sky') ? 'SkySports' : 'ESPN'
            break
          }
        }
        if (bestResult) break
      }

      if (!bestResult && (c.includes('arab') || c.includes('egypt') || c.includes('tunisia') || c.includes('qatar') || c.includes('saudi') || c.includes('algeria') || c.includes('morocco'))) {
        const googleResult = await this.fetchFromGoogleNews(teamName, 'ar')
        if (googleResult) {
          bestResult = googleResult
          sourceName = 'GoogleNews_AR'
        }
      }

      if (!bestResult) return null

      let sentimentScore = 0
      const impactTags = []

      bestResult.articles.slice(0, 3).forEach((article) => {
        const text = (article.title + ' ' + (article.contentSnippet || '')).toLowerCase()

        this.impactKeywords.negative.forEach((kw) => {
          if (text.includes(kw)) {
            sentimentScore -= 1
            impactTags.push(kw)
          }
        })

        this.impactKeywords.positive.forEach((kw) => {
          if (text.includes(kw)) {
            sentimentScore += 1
            impactTags.push(kw)
          }
        })
      })

      return {
        team: teamName,
        source: sourceName,
        newsCount: bestResult.articles.length,
        sentiment: sentimentScore,
        latestTitle: bestResult.articles[0].title,
        link: bestResult.articles[0].link,
        tags: [...new Set(impactTags)],
        timestamp: new Date().toISOString(),
      }
    } catch (error) {
      logger.warn(`[StitchNews] Coverage gap for ${teamName}: ${error.message}`)
      return null
    }
  }

  calculateNewsImpact(newsResult) {
    if (!newsResult) return { att: 1.0, def: 1.0, sentiment: 0 }

    let attMod = 1.0
    let defMod = 1.0

    if (newsResult.sentiment < 0) {
      const magnitude = Math.min(Math.abs(newsResult.sentiment), 3)
      attMod -= 0.05 * magnitude
      defMod += 0.03 * magnitude
    } else if (newsResult.sentiment > 0) {
      const magnitude = Math.min(newsResult.sentiment, 3)
      attMod += 0.03 * magnitude
      defMod -= 0.02 * magnitude
    }

    return {
      att: parseFloat(attMod.toFixed(2)),
      def: parseFloat(defMod.toFixed(2)),
      sentiment: newsResult.sentiment,
      summary: newsResult.latestTitle,
      source: newsResult.source || 'Global News',
    }
  }
}

module.exports = new GoalNewsService()
