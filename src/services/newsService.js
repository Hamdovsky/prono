const https = require('https');
const axios = require('axios');
const path = require('path');
const retry = require('async-retry');
const newsCache = require('./newsCache');
const { pooledConfig } = require('../../core/networkConfig');

const { spawn } = require('child_process');
const { getSofaHeaders, fetchWithRetry } = require('../../SofascoreScraping/src/apiClient');

const SOFA_API    = 'https://www.sofascore.com/api/v1';

const goalNewsService = require('../../services/goalNewsService');
const SENTIMENT_ENGINE = path.join(__dirname, '../../core/sentiment_engine.py');

/**
 * Enhanced Python-based Sentiment Analysis with Safety Timeout
 */
/**
 * Warp Speed Sentiment Analysis via Unified AI Gateway (Port 3001)
 */
async function callPythonSentiment(headlines, retryCount = 0) {
    if (!headlines || headlines.length === 0) {
        return { score: 0, label: 'Neutral', subjectivity: 0 };
    }

    try {
        // 🚀 [TITANIUM GATEWAY] Use unified Port 3001 (Node API Gateway)
        const response = await axios.post('http://127.0.0.1:3001/api/sentiment', { headlines }, {
            ...pooledConfig,
            timeout: 15000, // Sufficient for batch analysis in workers
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.API_SECRET_KEY || 'Matrix22!'}`
            }
        });

        if (response.data && response.data.success) {
            return response.data;
        } else {
            throw new Error(response.data?.error || 'Gateway Error');
        }
    } catch (err) {
        // [Reliability Fix] Fail-Safe Fallback: Neutral
        // We only warn if it's the first retry failure
        if (retryCount === 0) {
            // console.warn(`⚠️ [SentimentEngine] Gateway fallback: ${err.message}. Retrying...`);
            return await callPythonSentiment(headlines, retryCount + 1);
        }
        return { score: 0, label: 'Neutral', subjectivity: 0 };
    }
}

function filterRecent(items, maxHours = 48) {
    const cutoff = Date.now() - maxHours * 60 * 60 * 1000;
    return items.filter(item => {
        try {
            return new Date(item.pubDate).getTime() >= cutoff;
        } catch (_) {
            return true;
        }
    });
}

async function getEnglishNews(teamName, maxHours = 48) {
    const langs = [
        { q: teamName, hl: 'en', gl: 'US', ceid: 'US:en' } 
    ];

    const allNews = [];
    for (const l of langs) {
        const query = encodeURIComponent(`"${l.q}" injury absence lineup match prediction`);
        const url = `https://news.google.com/rss/search?q=${query}&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
        
        try {
            const items = await retry(async () => {
                const res = await axios.get(url, { ...pooledConfig, timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                const raw = res.data;
                return [...raw.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
                    const block = m[1];
                    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
                    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || new Date().toUTCString();
                    return { title, pubDate, lang: l.hl, source: 'google_news_en' };
                });
            }, { retries: 1 });
            allNews.push(...filterRecent(items, maxHours));
        } catch (_) {}
    }
    return allNews.slice(0, 10);
}

// ── V46: Arabic-Only News Fetcher (XGBoost Optimized) ──
async function getArabicNews(teamName, maxHours = 48) {
    const langs = [
        { q: teamName, hl: 'ar', gl: 'SA', ceid: 'SA:ar' } // Arabic Focus
    ];

    const allNews = [];
    for (const l of langs) {
        const query = encodeURIComponent(`"${l.q}" إصابة غياب تشكيلة مباراة`);
        const url = `https://news.google.com/rss/search?q=${query}&hl=${l.hl}&gl=${l.gl}&ceid=${l.ceid}`;
        
        try {
            const items = await retry(async () => {
                const res = await axios.get(url, { ...pooledConfig, timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                const raw = res.data;
                return [...raw.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
                    const block = m[1];
                    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
                    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || new Date().toUTCString();
                    return { title, pubDate, lang: l.hl, source: 'google_news_ar' };
                });
            }, { retries: 1 });
            allNews.push(...filterRecent(items, maxHours));
        } catch (_) {}
    }
    return allNews.slice(0, 10);
}


// ─────────────────────────────────────────────────────────────────────────────
// [V50] DYNAMIC SQUAD HEALTH — 3-Source Tiered Engine
//   Tier 1: Sofascore API (by teamId) — covers ALL teams worldwide ✅
//   Tier 2: Soccerway scraper (by team name) — for small/exotic leagues ✅
//   Tier 3: Transfermarkt map (elite fallback) — curated list ✅
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TIER 1: Sofascore Dynamic Missing Players
 * Uses the team's Sofascore ID — no static map needed!
 * Works for 100% of teams if _homeTeamId / _awayTeamId are present.
 */
async function getSofaMissingPlayers(teamId) {
    if (!teamId) return [];
    try {
        const url = `${SOFA_API}/team/${teamId}/missing-players`;
        const res = await fetchWithRetry(url, { headers: getSofaHeaders(`https://www.sofascore.com/team/football/team/${teamId}`) });
        const data = res ? await res.json() : null;
        const players = data?.missingPlayers || [];
        return players.slice(0, 10).map(p => ({
            name: p.player?.name || 'Unknown',
            position: p.player?.position || '?',
            reason: p.type || 'injury',
            description: p.description || '',
            returnDate: p.until ? new Date(p.until * 1000).toISOString().slice(0, 10) : 'Unknown',
            source: 'sofascore_official'
        }));
    } catch (e) { return []; }
}

/**
 * TIER 2: Soccerway Scraper (by team name)
 * Fallback for leagues not well-indexed in Sofascore.
 * Searches team page and scrapes injury/suspension table.
 */
async function getSoccerwayInjuries(teamName) {
    try {
        // Step 1: search the team
        const normName = teamName.replace(/\s+/g, '+');
        const searchUrl = `https://int.soccerway.com/search/teams/?q=${encodeURIComponent(teamName)}`;
        const searchRes = await axios.get(searchUrl, {
            ...pooledConfig,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json, text/javascript, */*' },
            timeout: 8000
        });

        // Soccerway search returns JSON with team suggestions
        const teamData = searchRes.data?.teams?.[0];
        if (!teamData || !teamData.url) return [];

        // Step 2: load the team's squad/absence page
        const teamUrl = `https://int.soccerway.com${teamData.url}`;
        const teamRes = await axios.get(teamUrl, {
            ...pooledConfig,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://int.soccerway.com/' },
            timeout: 8000
        });

        const html = teamRes.data;
        const injuries = [];

        // Parse injury table rows (usually class="injury" or in an "absences" section)
        const injuryRows = [...html.matchAll(/class="(?:injury|suspension|absent)[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)];
        for (const row of injuryRows.slice(0, 8)) {
            const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
                .map(c => c[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
            if (cells.length >= 2) {
                injuries.push({
                    name: cells[0],
                    reason: cells[1] || 'injury',
                    returnDate: cells[2] || 'Unknown',
                    source: 'soccerway'
                });
            }
        }
        return injuries;
    } catch (e) { return []; }
}

/**
 * TIER 3: Transfermarkt (static map for elite clubs as last resort)
 */
const TM_TEAM_MAP = {
    'Arsenal': { slug: 'arsenal-fc', id: 11 },
    'Chelsea': { slug: 'fc-chelsea', id: 631 },
    'Liverpool': { slug: 'fc-liverpool', id: 31 },
    'Manchester City': { slug: 'manchester-city', id: 281 },
    'Manchester United': { slug: 'manchester-united', id: 985 },
    'Tottenham': { slug: 'tottenham-hotspur', id: 148 },
    'Al-Hilal': { slug: 'al-hilal-saudi-fc', id: 1114 },
    'Al-Nassr': { slug: 'al-nassr-fc', id: 1478 },
    'Al-Ittihad': { slug: 'al-ittihad-club-jeddah', id: 1135 },
    'Al-Ahli': { slug: 'al-ahli-sfc', id: 1848 },
    'Al-Ahly': { slug: 'al-ahly-cairo', id: 7 },
    'Zamalek': { slug: 'zamalek-sc', id: 615 },
    'Barcelona': { slug: 'fc-barcelona', id: 131 },
    'Real Madrid': { slug: 'real-madrid', id: 418 },
    'Atletico Madrid': { slug: 'atletico-de-madrid', id: 13 },
    'Juventus': { slug: 'juventus-fc', id: 506 },
    'AC Milan': { slug: 'ac-mailand', id: 5 },
    'Inter': { slug: 'inter-mailand', id: 46 },
    'Roma': { slug: 'as-rom', id: 12 },
    'Napoli': { slug: 'ssc-neapel', id: 6195 },
    'Lazio': { slug: 'lazio-rom', id: 398 },
    'Bayern Munich': { slug: 'fc-bayern-munchen', id: 27 },
    'Borussia Dortmund': { slug: 'borussia-dortmund', id: 16 },
    'Bayer Leverkusen': { slug: 'bayer-04-leverkusen', id: 15 },
    'PSG': { slug: 'paris-saint-germain', id: 583 },
    'Marseille': { slug: 'olympique-marseille', id: 890 },
    'Porto': { slug: 'fc-porto', id: 720 },
    'Benfica': { slug: 'sl-benfica', id: 294 }
};

async function getTransfermarktInjuries(teamName) {
    const entry = TM_TEAM_MAP[teamName];
    if (!entry) return [];
    const url = `https://www.transfermarkt.com/${entry.slug}/verletzungen/verein/${entry.id}`;
    try {
        return await retry(async () => {
            const res = await axios.get(url, { ...pooledConfig, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            const injuries = [];
            const rowMatches = [...res.data.matchAll(/<tr[^>]*class="[^"]*zebra[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)];
            for (const row of rowMatches.slice(0, 8)) {
                const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
                    .map(c => c[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
                if (cells.length >= 3) {
                    injuries.push({ name: cells[0], reason: cells[2], returnDate: cells[cells.length - 1], source: 'transfermarkt' });
                }
            }
            return injuries;
        }, { retries: 1 });
    } catch (e) { return []; }
}

/**
 * MASTER: getSquadHealth — Tiered Multi-Source Engine
 * Priority: Sofascore (teamId) → Soccerway (name) → Transfermarkt (name)
 * Always returns an array of injury objects.
 */
async function getSquadHealth(teamName, teamId) {
    // Tier 1: Sofascore by ID (best coverage, most reliable)
    if (teamId) {
        const sofaInjuries = await getSofaMissingPlayers(teamId);
        if (sofaInjuries.length > 0) {
            return sofaInjuries;
        }
    }

    // Tier 2: Soccerway by name (for small leagues not indexed in Sofa)
    const swInjuries = await getSoccerwayInjuries(teamName);
    if (swInjuries.length > 0) {
        return swInjuries;
    }

    // Tier 3: Transfermarkt static map (elite clubs fallback)
    return await getTransfermarktInjuries(teamName);
}



async function getSofaLineups(sofaMatchId) {
    if (!sofaMatchId) return null;
    try {
        const url = `${SOFA_API}/event/${sofaMatchId}/lineups`;
        const res = await fetchWithRetry(url, { headers: getSofaHeaders(`https://www.sofascore.com/event/${sofaMatchId}`) });
        const data = res ? await res.json() : null;
        const result = { confirmed: false, home: [], away: [], injuries: [], missingKey: [] };
        if (data) {
            const d = data;
            result.confirmed = d.confirmed ?? false;
            const parseSquad = (team) => (team?.players || []).map(p => ({ id: p.player?.id, name: p.player?.name, position: p.position, substitute: !!p.substitute }));
            result.home = parseSquad(d.home);
            result.away = parseSquad(d.away);
            const parseMissing = (team, side) => (team?.missingPlayers || []).map(p => ({ name: p.player?.name, reason: p.type, position: p.player?.position, side }));
            result.missingKey = [...parseMissing(d.home, 'home'), ...parseMissing(d.away, 'away')];
        }
        return result;
    } catch (e) { return null; }
}

// ── V46: Intelligence Analysis (XGBoost Features) ──
function analyzeIntelligenceImpact(headlines, injuries) {
    let severity = 'MINOR';
    let impactScore = 0;
    
    // XGBoost Numerical Features
    const features = {
        is_missing_gk: 0,
        is_missing_scorer: 0,
        is_missing_captain: 0,
        is_missing_star: 0,
        absentee_count: injuries.length,
        news_intensity: headlines.length
    };

    const criticalKeywords = ['top scorer', 'captain', 'goalkeeper', 'gk', 'star', 'key player', 'crucial', 'هداّف', 'قائد', 'حارس', 'نجم', 'أفضل لاعب'];
    const moderateKeywords = ['defender', 'midfielder', 'substitution', 'rotation', 'مدافع', 'وسط', 'تدوير'];

    const allText = (headlines.join(' ') + ' ' + injuries.map(i => i.name + ' ' + i.reason).join(' ')).toLowerCase();

    // Feature Detection (Arabic & English)
    if (allText.match(/حارس|goalkeeper|gk/i)) features.is_missing_gk = 1;
    if (allText.match(/هداّف|top scorer|scorer/i)) features.is_missing_scorer = 1;
    if (allText.match(/قائد|captain/i)) features.is_missing_captain = 1;
    if (allText.match(/نجم|star|key player/i)) features.is_missing_star = 1;

    // Severity Logic
    if (features.is_missing_gk || features.is_missing_scorer || features.is_missing_star) {
        severity = 'CRITICAL';
        impactScore = -0.25;
    } else if (features.is_missing_captain || injuries.length > 3) {
        severity = 'MODERATE';
        impactScore = -0.12;
    }

    return {
        severity, impactScore, features,
        summary: severity === 'CRITICAL' ? '⚠️ غيابات جوهرية مؤثرة على التوقع' : (severity === 'MODERATE' ? '⚖️ غيابات متوسطة القوة' : '✅ لا مؤشرات سلبية قوية'),
        label_ar: severity === 'CRITICAL' ? 'حرج' : (severity === 'MODERATE' ? 'متوسط' : 'طبيعي')
    };
}

async function getPlayerFormRating(playerId) {
    if (!playerId) return null;
    try {
        const url = `${SOFA_API}/player/${playerId}/statistics`;
        const res = await fetchWithRetry(url, { headers: getSofaHeaders(`https://www.sofascore.com/player/player/${playerId}`) });
        const data = res ? await res.json() : null;
        return parseFloat(data?.statistics?.rating || 0);
    } catch (e) { return null; }
}

async function computeTeamFormRating(lineup) {
    return 0; // 🛡️ [OPTIMIZATION] Disabled redundant player rating fetches to save API quota
}


async function getNewsForTeam(teamName, maxHours = 48, options = {}) {
    const teamId = options.teamId || null;
    const [arNews, enNews, squadHealth, goalNews] = await Promise.allSettled([
        getArabicNews(teamName, maxHours),
        getEnglishNews(teamName, maxHours), 
        getSquadHealth(teamName, teamId),  // [V50] 3-tier dynamic engine
        goalNewsService.getTeamNews(teamName, options.countryHint || '')
    ]);
    const itemsAr = arNews.status === 'fulfilled' ? arNews.value : [];
    const itemsEn = enNews.status === 'fulfilled' ? enNews.value : [];
    const injuries = squadHealth.status === 'fulfilled' ? squadHealth.value : [];
    const gNews = (goalNews.status === 'fulfilled' && goalNews.value) ? [{ title: goalNews.value.latestTitle, pubDate: goalNews.value.timestamp, source: 'goal_direct' }] : [];
    const allNews = [...itemsAr, ...itemsEn, ...gNews];
    const intelligence = analyzeIntelligenceImpact(allNews.map(n => n.title), injuries);
    const sentiment = await callPythonSentiment(allNews.map(n => n.title));
    return { 
        headlines: allNews.map(n => n.title), items: allNews, injuries, intelligence,
        sentiment: { score: sentiment.score + intelligence.impactScore, verdict: intelligence.severity, label: intelligence.label_ar, subjectivity: sentiment.subjectivity },
        fetched_at: Date.now()
    };
}


async function getMatchIntelligence(sofaMatchId, homeTeam, awayTeam, matchTimestamp, { forceRefresh = false, countryHint = '', homeTeamId = null, awayTeamId = null } = {}) {
    const cacheKey = `match_intel_v50_${sofaMatchId}_${homeTeam}_${awayTeam}`;
    if (!forceRefresh) { const cached = newsCache.get(cacheKey); if (cached) return cached; }
    const [lineups, homeData, awayData] = await Promise.allSettled([
        getSofaLineups(sofaMatchId),
        getNewsForTeam(homeTeam, 48, { countryHint, teamId: homeTeamId }),  // [V50] pass teamId
        getNewsForTeam(awayTeam, 48, { countryHint, teamId: awayTeamId })   // [V50] pass teamId
    ]);
    const sofaLineups = lineups.status === 'fulfilled' ? lineups.value : null;
    const home = homeData.status === 'fulfilled' ? homeData.value : { headlines: [], injuries: [], intelligence: { severity: 'MINOR', impactScore: 0, features: {} } };
    const away = awayData.status === 'fulfilled' ? awayData.value : { headlines: [], injuries: [], intelligence: { severity: 'MINOR', impactScore: 0, features: {} } };

    if (sofaLineups?.missingKey?.length) {
        sofaLineups.missingKey.forEach(mp => {
            const target = mp.side === 'home' ? home : away;
            if (!target.injuries.find(i => i.name === mp.name)) target.injuries.push({ name: mp.name, reason: mp.reason, position: mp.position, source: 'sofascore_official' });
        });
    }

    let hForm = 0, aForm = 0;
    if (sofaLineups?.confirmed) {
        [hForm, aForm] = await Promise.all([computeTeamFormRating(sofaLineups.home), computeTeamFormRating(sofaLineups.away)]);
    }

    const result = {
        lineups: sofaLineups, home, away, confirmed: sofaLineups?.confirmed ?? false,
        home_form_rating: hForm, away_form_rating: aForm,
        intelligence_verdict: (home.intelligence.severity === 'CRITICAL' || away.intelligence.severity === 'CRITICAL') ? 'HIGH_INTEL' : 'NORMAL',
        fetched_at: Date.now()
    };
    newsCache.set(cacheKey, result, 2 * 60 * 60 * 1000);
    return result;
}

/**
 * V51: Real Head-to-Head (H2H) Fetcher
 * Fetches win/draw/loss stats from Sofascore for a specific match event.
 */
async function getSofaH2H(eventId) {
    if (!eventId) return null;
    try {
        const url = `${SOFA_API}/event/${eventId}/h2h`;
        const res = await fetchWithRetry(url, { headers: getSofaHeaders(`https://www.sofascore.com/event/${eventId}`) });
        return res ? await res.json() : null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    getNewsForTeam,
    getMatchIntelligence,
    getSofaLineups,
    getTransfermarktInjuries,
    getSquadHealth,
    getSofaH2H,
    filterRecent
};
