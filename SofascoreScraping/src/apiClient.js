const axios = require('axios');
const http = require('http');
const https = require('https');
const { pooledConfig } = require('../../core/networkConfig');
const shieldEngine = require('../../core/shieldEngine');
const Bottleneck = require('bottleneck');
const { redis, getCache, setCache } = require('../../core/redisClient');

// A list of modern Chrome-based User-Agents to match our sec-ch-ua headers
// A professional list of modern, high-reputation User-Agents (Windows, Mac, Linux, iOS, Android)
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0'
];

// Rate Limiter: HUMAN MODE (Indetectable)
const limiter = new Bottleneck({
    minTime: 1200,        // 🛡️ Raised to mimic human browsing speed
    maxConcurrent: 2     // 🛡️ Reduced concurrency to avoid IP flags
});

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const BASE_HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Origin': 'https://www.sofascore.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'x-requested-with': 'XMLHttpRequest',
    'DNT': '1'
};

// Persistent Puppeteer Session Pool
// 🧠 [BROWSER REUSE MANAGER]
let globalBrowser = null;
const pagePool = [];
const MAX_PAGES = 1; // 📉 Reduced for RAM safety
let isInitializingBrowser = false;
let requestsInCurrentBrowser = 0;
const RESTART_THRESHOLD = 100; // 🔄 Restart after 100 requests
const RAM_THRESHOLD_MB = 1500;  // 🔄 Restart if RAM > 1.5GB

async function getBrowser() {
    // 🧠 Check if restart needed (RAM or Request Count)
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    const needsRestart = requestsInCurrentBrowser >= RESTART_THRESHOLD || memUsage > RAM_THRESHOLD_MB;

    if (globalBrowser && needsRestart) {
        console.log(`🔄 [REUSE-MANAGER] Threshold reached (Reqs: ${requestsInCurrentBrowser}, RAM: ${memUsage.toFixed(0)}MB). Restarting Browser...`);
        await closeBrowser();
    }

    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
    
    if (isInitializingBrowser) {
        while (isInitializingBrowser) await new Promise(r => setTimeout(r, 500));
        if (globalBrowser) return globalBrowser;
    }

    isInitializingBrowser = true;
    try {
        const puppeteer = require('puppeteer-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());

        console.log(`🤖 [Puppeteer] Launching persistent stealth browser (PAGE POOL MODE)...`);
        globalBrowser = await puppeteer.launch({
            headless: true, // 🚀 Uses the modern "New Headless" engine
            protocolTimeout: 120000, // 🛡️ Prevent Runtime.callFunctionOn timeout
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,720',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });
        
        // Initialize pool
        for (let i = 0; i < MAX_PAGES; i++) {
            const page = await globalBrowser.newPage();
            const ua = getRandomUserAgent();
            await page.setUserAgent(ua);
            await page.setViewport({ width: 1280, height: 720 });
            await page.setExtraHTTPHeaders({ 
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': ua
            });
            
            console.log(`🤖 [Puppeteer] Page ${i+1} warming up (BEHAVIORAL SIMULATION)...`);
            try {
                await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
                
                // 🛡️ [TITANIUM STEALTH] Simulate Human Interaction
                await page.mouse.move(Math.random() * 500, Math.random() * 500);
                await page.evaluate(() => window.scrollBy(0, Math.random() * 300));
                await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
                
            } catch (e) { /* ignore */ }
            
            pagePool.push({ page, busy: false });
        }
    } finally {
        isInitializingBrowser = false;
    }
    return globalBrowser;
}

async function closeBrowser() {
    try {
        if (globalBrowser) {
            await globalBrowser.close().catch(() => {});
        }
    } finally {
        globalBrowser = null;
        pagePool.length = 0;
        requestsInCurrentBrowser = 0;
    }
}

async function fetchWithPuppeteer(url) {
    await getBrowser();
    
    // Acquire page
    let entry = pagePool.find(p => !p.busy);
    if (!entry) {
        // Wait for a page to become free (max 30s)
        const waitStart = Date.now();
        while (!entry) {
            if (Date.now() - waitStart > 30000) throw new Error('Page pool wait timeout (30s)');
            await new Promise(r => setTimeout(r, 500));
            entry = pagePool.find(p => !p.busy);
        }
    }
    
    entry.busy = true;
    requestsInCurrentBrowser++;
    try {
        const page = entry.page;
        console.log(`🤖 [Puppeteer] Page Pool Fetching: ${url}`);

        // ════════════════════════════════════════════════════════════
        // STRATEGY 1: page.goto() → page.content()
        //   Navigate directly to the JSON API URL. Chrome renders it as
        //   a plain text page (<body><pre>…JSON…</pre></body>).
        //   ✅ Avoids CDP serialization overhead (critical for 700+ match payloads)
        //   ✅ Inherits browser cookies/session set during warm-up
        //   ✅ No AbortController race needed — goto() has its own timeout
        // ════════════════════════════════════════════════════════════
        let jsonData = null;
        let gotoFailed = false;

        try {
            const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 45000  // 45s — large payloads need time to transfer
            });

            const status = response ? response.status() : 0;

            if (status === 404) {
                return null;
            }
            if (status === 403 || status === 429) {
                throw new Error(`HTTP ${status}`);
            }
            if (!response || !response.ok()) {
                throw new Error(`HTTP ${status}`);
            }

            // Extract JSON from page body text (Chrome wraps JSON in <pre> tag)
            const bodyText = await page.evaluate(() => {
                const pre = document.querySelector('pre');
                return pre ? pre.textContent : document.body.innerText;
            });

            if (!bodyText || bodyText.trim() === '') {
                throw new Error('Empty response body from goto()');
            }

            jsonData = JSON.parse(bodyText);
            
            // 🚀 [TITANIUM OPTIMIZATION] Extract cookies to rescue Axios
            try {
                const cookies = await page.cookies();
                if (cookies.length > 0) {
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    global.sofascore_cookies = cookieStr;
                    // Persist to Redis for other processes and restarts
                    if (redis) {
                        await redis.set('scraper:sofascore_cookies', cookieStr, 'EX', 86400); // 24h
                    }
                }
            } catch (e) { /* ignore */ }
            
        } catch (gotoErr) {
            gotoFailed = true;
            // If it's a hard HTTP error (403/429) re-throw immediately — no point falling back
            if (gotoErr.message.startsWith('HTTP ')) throw gotoErr;
            console.warn(`⚠️ [Puppeteer] goto() failed for ${url}: ${gotoErr.message}. Trying evaluate() fallback...`);
        }

        // ════════════════════════════════════════════════════════════
        // STRATEGY 2: evaluate() fetch fallback (for edge cases where
        //   goto() can't be used, e.g. CORS-blocked navigation)
        //   Only used if strategy 1 failed with a non-HTTP error.
        // ════════════════════════════════════════════════════════════
        if (gotoFailed) {
            const jsonResponse = await Promise.race([
                page.evaluate(async (apiUrl) => {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s internal
                        const res = await fetch(apiUrl, {
                            headers: { 'Accept': '*/*', 'x-requested-with': 'XMLHttpRequest' },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                        if (res.status === 404) return null;
                        if (!res.ok) return { errorStatus: res.status };
                        return await res.json();
                    } catch (err) {
                        return { error: err.message };
                    }
                }, url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Evaluate execution timed out (35s)')), 35000))
            ]);

            if (jsonResponse === null) return null;
            if (jsonResponse && jsonResponse.errorStatus) throw new Error(`HTTP ${jsonResponse.errorStatus}`);
            if (jsonResponse && jsonResponse.error) throw new Error(jsonResponse.error);
            jsonData = jsonResponse;
            
            try {
                const cookies = await page.cookies();
                if (cookies.length > 0) {
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    global.sofascore_cookies = cookieStr;
                    if (redis) {
                        await redis.set('scraper:sofascore_cookies', cookieStr, 'EX', 86400);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        return {
            ok: true,
            status: 200,
            json: async () => jsonData
        };
    } catch (error) {
        console.error(`❌ [Puppeteer] Pool fetch failed for ${url}:`, error.message);
        
        const isFatal = 
            error.message.includes('Target closed') || 
            error.message.includes('Session closed') || 
            error.message.includes('Execution context was destroyed') ||
            error.message.includes('Page pool wait timeout') ||
            error.message.toLowerCase().includes('detached frame');
        
        if (isFatal && globalBrowser) {
            console.warn('🔄 [Puppeteer] Fatal error detected — recycling browser instance...');
            await globalBrowser.close().catch(() => {});
            globalBrowser = null;
            pagePool.length = 0;
        } else if (error.message.includes('HTTP 403') || error.message.includes('HTTP 429')) {
            // 🚨 [TITANIUM STEALTH] Detection Triggered!
            const cooldown = 5 * 60 * 1000; // 5 minutes sleep
            console.error(`🚨 [STEALTH] Detection detected (HTTP 403/429). Entering COOLDOWN for ${cooldown/1000}s...`);
            await new Promise(r => setTimeout(r, cooldown));
        } else if (error.message.includes('timed out') && entry) {
            // 🔄 Non-fatal timeout: recycle only the hung page
            console.warn(`🔄 [Puppeteer] Page timeout — recycling page slot ${pagePool.indexOf(entry) + 1}...`);
            try {
                await entry.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
            } catch (_) { /* ignore */ }
        }
        throw error;
    } finally {
        if (entry) {
            // 🧹 [MEMORY TRIMMING] Reset page state
            // Removed about:blank navigation on successful requests to avoid detached frame errors and improve speed
            entry.busy = false;
        }
    }
}

/**
 * Robust fetch with retries and backoff using Axios, with Puppeteer fallback
 */
async function fetchWithRetry(url, options = {}, retries = 3) {
    return limiter.schedule(async () => {
        let lastError = null;
        
        // Dynamic Referer based on endpoint
        let referer = 'https://www.sofascore.com/';
        if (url.includes('/event/')) {
            const match = url.match(/\/event\/(\d+)/);
            if (match) referer = `https://www.sofascore.com/event/${match[1]}`;
        } else if (url.includes('/team/')) {
            const match = url.match(/\/team\/(\d+)/);
            if (match) referer = `https://www.sofascore.com/team/football/team/${match[1]}`;
        } else if (url.includes('/unique-tournament/')) {
            const match = url.match(/\/unique-tournament\/(\d+)/);
            if (match) referer = `https://www.sofascore.com/tournament/football/league/${match[1]}`;
        }

        for (let i = 0; i < retries; i++) {
            try {
                // 🛡️ [TITANIUM STEALTH] Dynamic Jitter
                const jitter = Math.floor(Math.random() * 1500) + 500; 
                await new Promise(r => setTimeout(r, jitter));

                const currentProxy = shieldEngine.getProxy();
                const axiosConfig = {
                    ...pooledConfig,
                    ...options,
                    url,
                    timeout: 15000, // 15s timeout for axios
                    method: options.method || 'GET',
                    headers: {
                        ...BASE_HEADERS,
                        'Referer': referer,
                        'User-Agent': getRandomUserAgent(),
                        ...options.headers
                    }
                };
                
                // 🚀 [TITANIUM OPTIMIZATION] Inject Puppeteer Session Cookies if available
                if (!global.sofascore_cookies) {
                    try {
                        const saved = await redis.get('scraper:sofascore_cookies');
                        if (saved) {
                            global.sofascore_cookies = saved;
                            console.log('✅ [apiClient] Restored cookies from Redis');
                        }
                    } catch (e) { /* ignore */ }
                }

                if (global.sofascore_cookies) {
                    axiosConfig.headers['Cookie'] = global.sofascore_cookies;
                }

                if (currentProxy && currentProxy !== 'DIRECT') {
                    const pUrl = new URL(currentProxy);
                    axiosConfig.proxy = {
                        protocol: pUrl.protocol.replace(':', ''),
                        host: pUrl.hostname,
                        port: pUrl.port,
                        auth: pUrl.username ? { username: pUrl.username, password: pUrl.password } : undefined
                    };
                }

                const response = await axios(axiosConfig);
                return {
                    ok: true,
                    status: response.status,
                    json: async () => response.data
                };
            } catch (e) {
                lastError = e;
                const status = e.response?.status;
                
                if (status === 403 || status === 429) {
                    // 🛡️ [OPTIMIZATION] Skip Puppeteer for non-critical player stats to prevent hangs
                    if (url.includes('/player/') && url.includes('/statistics')) {
                        console.warn(`🛡️ [apiClient] 403 on non-critical Player Stats. Skipping Puppeteer bypass to save time.`);
                        return null; 
                    }

                    console.warn(`🚨 [apiClient] ${status} on ${url}. Attempting Puppeteer bypass...`);
                    try {
                        return await fetchWithPuppeteer(url);
                    } catch (puppeteerErr) {
                        const wait = (i + 1) * 5000 + Math.floor(Math.random() * 3000); 
                        console.warn(`🚨 [apiClient] Puppeteer also failed. Retrying in ${wait}ms...`);
                        await new Promise(r => setTimeout(r, wait));
                    }
                } else if (status === 404) {
                    return null;
                } else {
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }
        return null; // Return null instead of throwing to keep the workflow moving
    });
}

const SofaAPI = {
    BASE: 'https://www.sofascore.com/api/v1',

    async getEvents(date) {
        const res = await fetchWithRetry(`${this.BASE}/sport/football/scheduled-events/${date}`);
        return res ? res.json() : { events: [] };
    },

    async getLiveEvents() {
        const res = await fetchWithRetry(`${this.BASE}/sport/football/events/live`);
        return res ? res.json() : { events: [] };
    },

    async getMatchStats(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/statistics`);
        return res ? res.json() : null;
    },

    async getMatchDetails(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}`);
        return res ? res.json() : null;
    },

    async getLineups(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/lineups`);
        return res ? res.json() : null;
    },

    async getMatchGraph(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/graph`);
        return res ? res.json() : null;
    },

    async getOddsFeatured(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/odds/1/featured`);
        return res ? res.json() : null;
    },

    async getTeamStats(teamId, tournamentId, seasonId) {
        const res = await fetchWithRetry(`${this.BASE}/team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`);
        return res ? res.json() : null;
    },

    async getTeamForm(teamId, tournamentId, seasonId) {
        const res = await fetchWithRetry(`${this.BASE}/team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/events/last/5`);
        return res ? res.json() : null;
    },

    async getStandings(tournamentId, seasonId) {
        const res = await fetchWithRetry(`${this.BASE}/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`);
        return res ? res.json() : null;
    },

    async getH2H(matchId) {
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/h2h/events`);
        return res ? res.json() : null;
    },

    async getTeamPlayers(teamId) {
        const res = await fetchWithRetry(`${this.BASE}/team/${teamId}/players`);
        return res ? res.json() : { players: [] };
    },

    async getPlayerStats(playerId, tournamentId, seasonId) {
        const res = await fetchWithRetry(`${this.BASE}/player/${playerId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`);
        return res ? res.json() : null;
    },

    async getRefereeStats(refereeId) {
        const res = await fetchWithRetry(`${this.BASE}/referee/${refereeId}/statistics/overall`);
        return res ? res.json() : null;
    },

    async getRefereeMatchHistory(refereeId) {
        const res = await fetchWithRetry(`${this.BASE}/referee/${refereeId}/events/last/10`);
        return res ? res.json() : null;
    },

    async getTournamentSeasons(tournamentId) {
        const res = await fetchWithRetry(`${this.BASE}/unique-tournament/${tournamentId}/seasons`);
        return res ? res.json() : null;
    },

    async getTournamentEvents(tournamentId, seasonId, type = 'next') {
        // type can be 'next' or 'last'
        const res = await fetchWithRetry(`${this.BASE}/unique-tournament/${tournamentId}/season/${seasonId}/events/${type}/0`);
        return res ? res.json() : { events: [] };
    },

    // ==========================================
    // 🎯 NEW: XG (Expected Goals) & HEATMAPS
    // ==========================================
    
    async getMatchShotmap(matchId) {
        // Returns all shots with xG (Expected Goals), xGOT, coordinates, and shot type
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/shotmap`);
        return res ? res.json() : null;
    },

    async getPlayerMatchHeatmap(matchId, playerId) {
        // Returns the positional heatmap coordinates for a specific player in a specific match
        const res = await fetchWithRetry(`${this.BASE}/event/${matchId}/player/${playerId}/heatmap`);
        return res ? res.json() : null;
    },

    async getPlayerSeasonHeatmap(playerId, tournamentId, seasonId) {
        // Returns the aggregated heatmap for a player over an entire season
        const res = await fetchWithRetry(`${this.BASE}/player/${playerId}/unique-tournament/${tournamentId}/season/${seasonId}/heatmap`);
        return res ? res.json() : null;
    }
};

function getSofaHeaders(referer = 'https://www.sofascore.com/') {
    return {
        ...BASE_HEADERS,
        'Referer': referer,
        'User-Agent': getRandomUserAgent()
    };
}

module.exports = {
    fetchWithRetry,
    getRandomUserAgent,
    BASE_HEADERS,
    getSofaHeaders,
    SofaAPI
};
