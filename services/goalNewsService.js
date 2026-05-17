const axios = require('axios');
const Parser = require('rss-parser');
const retry = require('async-retry');
const logger = require('../core/logger');
const { pooledConfig } = require('../core/networkConfig');
const parser = new Parser();

/**
 * [STITCH V21] Global News Multi-provider
 * Replaces defunct Goal.com RSS with BBC, Sky, and ESPN
 */
class GoalNewsService {
    constructor() {
        this.sources = {
            en: [
                'https://www.skysports.com/rss/11095',
                'https://push.api.bbci.co.uk/morph/data/bbc-morph-feeds-rss/feed/sport/football/rss.xml',
                'https://www.espn.com/espn/rss/soccer/news'
            ],
            ar: [
                'https://www.kooora.com/rss.aspx?c=0',
                'https://www.hespress.com/sport/feed',
                'https://www.elbotola.com/rss/',
                'https://www.youm7.com/rss/Section/298',
                'https://www.aljazeera.net/sport/rss',
                'https://sport.almarssad.com/feed/',
                'https://www.almountakhab.com/rss.xml',
                'https://ar.kingfut.com/feed/',
                'https://m.al-sharq.com/rss/sport'
            ],
            fr: [
                'https://www.france24.com/fr/sport/rss',
                'https://sport.le360.ma/rss.xml',
                'https://www.lequipe.fr/rss/actu_rss_Football.xml'
            ],
            br: [
                'https://www.espn.com/espn/rss/soccer/news' // Fallback to EN for BR
            ]
        };

        this.impactKeywords = {
            negative: [
                'injury', 'injured', 'broken', 'suspension', 'suspended', 'doubtful', 'misses', 'absent', 'rested', 'crisis', 'defeat', 'out for',
                'إصابة', 'غياب', 'توقف', 'إيقاف', 'شكوك', 'أزمة', 'خسارة', 'استبعاد', 'كسر', 'تمزق', 'ضربة موجعة',
                'blessure', 'suspendu', 'lesão', 'desfalque'
            ],
            positive: [
                'returns', 'fit', 'back', 'recovered', 'available', 'starts', 'boost', 'signing', 'win', 'confident',
                'عودة', 'جاهز', 'مستعد', 'تعافي', 'فوز', 'ثقة', 'دعم', 'توقيع', 'مشاركة', 'جاهزية',
                'retour', 'disponible', 'reforço', 'confiante'
            ]
        };
    }

    /**
     * Normalize team name for searching in titles
     */
    normalize(name) {
        if (!name) return "";
        let n = name.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
            .replace(/\((.*?)\)/g, '') // remove anything in parentheses
            .trim();
        
        // Selective noise removal — PRESERVE identifying suffixes like City/United/United/Al/Athletic
        const noise = /\b(fc|club|ca|pfk|clube|sc|as|sd|ud|cd|juventude|esporte|recreativo)\b/gi;
        return n.replace(noise, '').replace(/\s+/g, ' ').trim();
    }

    /**
     * Fetch news from a specific URL with retry
     */
    async fetchFromUrl(teamName, url) {
        try {
            return await retry(async (bail, attempt) => {
                const response = await axios.get(url, { 
                    ...pooledConfig,
                    timeout: 5000, 
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Safari/537.36' } 
                });
                
                const feed = await parser.parseString(response.data);
                const normName = this.normalize(teamName);
                
                const teamArticles = feed.items.filter(item => {
                    const text = (item.title + ' ' + (item.contentSnippet || '')).toLowerCase();
                    const normText = this.normalize(text);
                    return normText.includes(normName);
                });

                if (teamArticles.length > 0) {
                    return { articles: teamArticles };
                }
                return null;
            }, {
                retries: 1,
                minTimeout: 1000
            });
        } catch (e) {
            return null;
        }
    }

    /**
     * Fetch and analyze news for a specific team with multi-source fallback
     */
    async getTeamNews(teamName, countryHint = '') {
        try {
            const c = (countryHint || '').toLowerCase();
            let langOrder = ['en'];
            
            if (c.includes('brazil') || c.includes('portugal')) langOrder = ['en'];
            else if (c.includes('france') || c.includes('senegal') || c.includes('algeria') || c.includes('morocco')) langOrder = ['fr', 'en', 'ar'];
            else if (c.includes('arab') || c.includes('egypt') || c.includes('tunisia') || c.includes('qatar')) langOrder = ['ar', 'en'];
            
            const uniqueLangs = [...new Set([...langOrder, 'en', 'ar', 'fr'])];

            let bestResult = null;
            let sourceName = '';

            for (const lang of uniqueLangs) {
                const urls = this.sources[lang] || [];
                for (const url of urls) {
                    const res = await this.fetchFromUrl(teamName, url);
                    if (res) {
                        bestResult = res;
                        sourceName = url.includes('bbc') ? 'BBC' : (url.includes('sky') ? 'SkySports' : 'ESPN');
                        break;
                    }
                }
                if (bestResult) break;
            }

            if (!bestResult) return null;

            let sentimentScore = 0;
            let impactTags = [];

            bestResult.articles.slice(0, 3).forEach(article => {
                const text = (article.title + ' ' + (article.contentSnippet || '')).toLowerCase();
                
                this.impactKeywords.negative.forEach(kw => {
                    if (text.includes(kw)) {
                        sentimentScore -= 1;
                        impactTags.push(kw);
                    }
                });

                this.impactKeywords.positive.forEach(kw => {
                    if (text.includes(kw)) {
                        sentimentScore += 1;
                        impactTags.push(kw);
                    }
                });
            });

            return {
                team: teamName,
                source: sourceName,
                newsCount: bestResult.articles.length,
                sentiment: sentimentScore,
                latestTitle: bestResult.articles[0].title,
                link: bestResult.articles[0].link,
                tags: [...new Set(impactTags)],
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            logger.warn(`⚠️ [StitchNews] Coverage gap for ${teamName}: ${error.message}`);
            return null;
        }
    }

    /**
     * Maps sentiment to xG modifiers compatible with Stitch V13
     */
    calculateNewsImpact(newsResult) {
        if (!newsResult) return { att: 1.0, def: 1.0, sentiment: 0 };

        let attMod = 1.0;
        let defMod = 1.0;

        if (newsResult.sentiment < 0) {
            const magnitude = Math.min(Math.abs(newsResult.sentiment), 3);
            attMod -= (0.05 * magnitude);
            defMod += (0.03 * magnitude);
        } else if (newsResult.sentiment > 0) {
            const magnitude = Math.min(newsResult.sentiment, 3);
            attMod += (0.03 * magnitude);
            defMod -= (0.02 * magnitude);
        }

        return {
            att: parseFloat(attMod.toFixed(2)),
            def: parseFloat(defMod.toFixed(2)),
            sentiment: newsResult.sentiment,
            summary: newsResult.latestTitle,
            source: newsResult.source || 'Global News'
        };
    }
}

module.exports = new GoalNewsService();
