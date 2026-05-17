const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { readScraperProgress } = require('../core/utils');

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];
const getRandomUA = () => userAgents[Math.floor(Math.random() * userAgents.length)];

// Singleton browser instance
let globalBrowser = null;

async function getBrowser() {
    if (globalBrowser) {
        try {
            const pages = await globalBrowser.pages();
            if (pages.length > 0) return globalBrowser;
        } catch (e) {
            console.log('[SCRAPER] Browser disconnected, restarting...');
            globalBrowser = null;
        }
    }
    
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    const stealth = StealthPlugin();
    stealth.enabledEvasions.delete('iframe.contentWindow'); // Prevent some 403 blocks
    stealth.enabledEvasions.delete('media.codecs');
    puppeteer.use(stealth);

    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    let executablePath;
    for (const p of paths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
    }

    globalBrowser = await puppeteer.launch({
        headless: 'new',
        executablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--ignore-certificate-errors',
            '--window-size=1920,1080'
        ]
    });
    
    return globalBrowser;
}

const scraperSchedule = { times: ['06:00', '12:00', '18:00'], lastRun: null, nextRun: null, running: false };

function calcNextScraperRun() {
    const now = new Date();
    const times = scraperSchedule.times.map(t => {
        const [h, m] = t.split(':').map(Number);
        const dt = new Date();
        dt.setHours(h, m, 0, 0);
        if (dt <= now) dt.setDate(dt.getDate() + 1);
        return dt;
    });
    times.sort((a, b) => a - b);
    return times[0].toISOString();
}

/**
 * GET /api/scraper/status
 */
router.get('/scraper/status', async (req, res) => {
    scraperSchedule.nextRun = calcNextScraperRun();
    const progress = await readScraperProgress();
    res.json({
        ...scraperSchedule,
        ...progress
    });
});

/**
 * POST /api/news-watch/refresh
 */
router.post('/news-watch/refresh', async (req, res) => {
    try {
        const enrichNewsProcessor = require('../core/_enrich_news');
        const force = req.query.force === 'true';
        const result = await enrichNewsProcessor.run(force);
        res.json({ success: true, result });
    } catch (e) {
        console.error('[NEWS-WATCH REFRESH ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/scan-today
 * Triggers a manual SofaScore scan for today's matches.
 */
router.post('/scan-today', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'update_today.js');
        
        console.log('⚡ [API] Triggering manual SofaScore scan...');
        
        // Execute in background to avoid timeout
        exec(`node "${scriptPath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ [SCAN-TODAY] Error:', error.message);
                return;
            }
            console.log('✅ [SCAN-TODAY] Scan complete.');
        });
        
        res.json({ success: true, message: 'Scan started in background' });
    } catch (e) {
        console.error('[SCAN-TODAY ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/scraper/betx2-players  (alias – kept for compat)
 */
router.post('/scraper/betx2-players', (req, res) => res.redirect(307, '/api/scraper/betx2-ticket'));

/**
 * POST /api/scraper/betx2-ticket
 */
router.post('/scraper/betx2-ticket', async (req, res) => {
    const { ticketId } = req.body;
    if (!ticketId) return res.status(400).json({ error: 'Ticket ID is required' });

    let browser;
    try {
        browser = await getBrowser();

        // ── الخطوة 1: تحميل الصفحة الرئيسية لجلب رابط الـ iframe ──
        const mainPage = await browser.newPage();
        const ua = getRandomUA();
        await mainPage.setViewport({ width: 1366, height: 768 });
        await mainPage.setUserAgent(ua);
        await mainPage.setExtraHTTPHeaders({
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
        });

        console.log('[BETX2] Loading main page...');
        await mainPage.goto('https://betx2.com/fr/sport', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 4000));

        // جلب رابط الـ iframe الرياضي
        const sportIframeUrl = await mainPage.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            for (const f of iframes) {
                if (f.src && f.src.includes('sport.betx2.com')) return f.src;
            }
            return null;
        });
        console.log('[BETX2] Sport iframe URL found:', !!sportIframeUrl);
        await mainPage.close();

        // ── الخطوة 2: فتح الـ iframe مباشرةً في صفحة جديدة ──
        const sportPage = await browser.newPage();
        await sportPage.setViewport({ width: 1366, height: 2000 }); // كبير لتغطية لوحة COUPON
        await sportPage.setUserAgent(ua);
        await sportPage.setExtraHTTPHeaders({
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
        });

        const targetUrl = sportIframeUrl ||
            'https://sport.betx2.com/afdb6836-2b81-4931-a030-8a97d61a13d6/SportsBook/Home?token=-&d=d&l=fr&tz=&parent=betx2.com&sportsBookView=europeanView';

        console.log('[BETX2] Navigating to sport page...');
        await sportPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 5000));

        console.log('[BETX2] Clicking coupon button...');
        const couponOpened = await sportPage.evaluate(() => {
            // 1. Primary Selectors
            const primarySelectors = [
                '.dg_bs_slip_bar', '[class*="slip_bar"]', '[class*="coupon_bar"]',
                '[class*="betslip_bar"]', '[class*="book_bar"]', '[class*="bs_bar"]'
            ];
            for (const sel of primarySelectors) {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) { 
                    el.click(); 
                    return { method: 'primary', selector: sel }; 
                }
            }

            // 2. Self-Healing Discovery (Dynamic)
            const allElements = document.querySelectorAll('button, div, span, a');
            const keywords = ['coupon de pari', 'paris enregistr', 'vérificateur', 'bet slip', 'betslip', 'pari'];
            
            let bestMatch = null;
            let highestScore = 0;

            for (const el of allElements) {
                const text = (el.textContent || '').toLowerCase().trim();
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;

                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        let score = (text === kw) ? 100 : 50;
                        if (el.tagName === 'BUTTON') score += 20;
                        if (score > highestScore) {
                            highestScore = score;
                            bestMatch = el;
                        }
                    }
                }
            }

            if (bestMatch) {
                bestMatch.click();
                return { method: 'self-healing', text: bestMatch.textContent.trim() };
            }
            return false;
        });
        console.log('[BETX2] Coupon open result:', couponOpened);
        console.log('[BETX2] Coupon open result:', couponOpened);
        await new Promise(r => setTimeout(r, 3000));

        // ── الخطوة 4: البحث عن حقل إدخال رقم التذكرة (Self-Healing) ──
        console.log('[BETX2] Searching for ticket input...');
        const inputTyped = await sportPage.evaluate((ticketId) => {
            // 1. محاولة استخدام الـ selectors المعروفة
            const known = [
                'input.dg_bs_book_input', 'input[class*="book_input"]',
                'input[placeholder*="nregistrement"]', 'input[placeholder*="oupon"]',
                'input[placeholder*="icket"]', 'input[placeholder*="ode"]'
            ];
            
            for (const sel of known) {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) {
                    el.focus();
                    el.value = ticketId;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return { method: 'known', selector: sel };
                }
            }

            // 2. اكتشاف ديناميكي إذا تغير التصميم
            const allInputs = Array.from(document.querySelectorAll('input'));
            const patterns = ['code', 'ticket', 'coupon', 'pari', 'booking', 'regist'];
            
            for (const inp of allInputs) {
                const ph = (inp.placeholder || '').toLowerCase();
                const cls = (inp.className || '').toLowerCase();
                const id = (inp.id || '').toLowerCase();
                
                if (patterns.some(p => ph.includes(p) || cls.includes(p) || id.includes(p))) {
                    if (inp.type === 'text' || !inp.type) {
                        inp.focus();
                        inp.value = ticketId;
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        return { method: 'dynamic-discovery', id: inp.id, placeholder: inp.placeholder };
                    }
                }
            }
            return null;
        }, String(ticketId));

        if (!inputTyped) {
            throw new Error('Self-healing failed: No ticket input found even with dynamic discovery.');
        }
        console.log('[BETX2] Input result:', inputTyped);

        await new Promise(r => setTimeout(r, 500));

        // ── الخطوة 5: النقر على زر Confirmer ──
        console.log('[BETX2] Clicking Confirmer...');
        const confirmClicked = await sportPage.evaluate(() => {
            const sels = [
                'button.dg_bs_book_btn', '[class*="book_btn"]', '[class*="confirm_btn"]',
                'button[class*="confirm"]', '[class*="verify_btn"]'
            ];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) { el.click(); return sel; }
            }
            // نصي
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            for (const b of btns) {
                const t = (b.textContent || '').toLowerCase().trim();
                if ((t.includes('confirm') || t.includes('vérif') || t.includes('check') || t === 'ok')
                    && b.getBoundingClientRect().width > 0) {
                    b.click(); return 'text:' + t;
                }
            }
            return false;
        });
        if (!confirmClicked) await sportPage.keyboard.press('Enter');
        console.log('[BETX2] Confirm result:', confirmClicked);

        // ── الخطوة 6: انتظار النتيجة ──
        await new Promise(r => setTimeout(r, 6000));

        // ── الخطوة 7: استخراج البيانات ──
        const resultData = await sportPage.evaluate(() => {
            const sels = [
                '[class*="book_result"]', '[class*="coupon_result"]', '[class*="ticket_result"]',
                '[class*="slip_content"]', '[class*="betslip_content"]', '[class*="bs_content"]',
                '.dg_bs_slip', '[class*="bs_slip"]'
            ];
            let out = '';
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.innerText) out += el.innerText + '\n';
            }
            return out || document.body.innerText;
        });

        // ── الخطوة 8: تحليل النتيجة ──
        const lower = resultData.toLowerCase();
        let status = 'Pending';
        if (lower.includes('gagn') || lower.includes('won') || lower.includes('win')) status = 'Won';
        if (lower.includes('perd') || lower.includes('lost') || lower.includes('perdu'))  status = 'Lost';
        if (lower.includes('en cours') || lower.includes('ouvert') || lower.includes('pending')) status = 'Pending';

        let totalOdds = 1.0;
        for (const pat of [
            /cote[s]?\s*(?:totale)?\s*:?\s*([\d,\.]+)/i,
            /total\s*(?:odds|cote)\s*:?\s*([\d,\.]+)/i,
            /([\d]+[,\.][\d]+)\s*(?:TND|cote)/i
        ]) {
            const m = resultData.match(pat);
            if (m) { const v = parseFloat(m[1].replace(',', '.')); if (!isNaN(v) && v > 1) { totalOdds = v; break; } }
        }

        let matchCount = 0;
        const matchM = resultData.match(/(\d+)\s*(?:match|événement|event|sélection)/i);
        if (matchM) matchCount = parseInt(matchM[1]) || 0;
        if (!matchCount) {
            const oddsLines = resultData.split('\n').filter(l => /\d+[,.]\d+/.test(l));
            matchCount = oddsLines.length || 0;
        }

        res.json({
            success: true,
            tickets: [{
                id: ticketId,
                date: new Date().toISOString().split('T')[0],
                matches: matchCount,
                totalOdds: totalOdds || 1.0,
                status,
                rawText: resultData.substring(0, 500)
            }]
        });

    } catch (e) {
        console.error('[SCRAPER TICKET ERROR]', e.message);
        res.status(500).json({ error: e.message });
    } finally {
        if (browser) {
            try {
                const pages = await browser.pages();
                for (const p of pages) {
                    if (p.url() !== 'about:blank') await p.close();
                }
            } catch (e) { console.error('[SCRAPER] Error closing pages:', e.message); }
        }
    }
});

/**
 * POST /api/scraper/bibeet-ticket
 * Scraper Bibeet.com — Altenar WSDK
 * Stratégie : Naviguer vers l'iframe + utiliser widget "Search bets"
 */
router.post('/scraper/bibeet-ticket', async (req, res) => {
    const { ticketId, mode = 'betid' } = req.body;
    if (!ticketId) return res.status(400).json({ error: 'Ticket ID requis' });

    let browser;
    try {
        browser = await getBrowser();
        const ua = getRandomUA();

        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        await page.setUserAgent(ua);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1'
        });

        console.log('[BIBEET] Loading parent page...');
        await page.goto('https://bibeet.com/betting#/overview', {
            waitUntil: 'domcontentloaded', timeout: 60000
        });
        await new Promise(r => setTimeout(r, 6000));

        console.log('[BIBEET] Searching for Altenar iframe...');
        let sportFrame = null;
        const frames = page.frames();
        for (const f of frames) {
            const url = f.url().toLowerCase();
            if (url.includes('altenar') || url.includes('biahosted') || url.includes('dazzabet')) {
                sportFrame = f;
                break;
            }
        }

        const target = sportFrame || page;
        console.log(`[BIBEET] Target: ${sportFrame ? 'Altenar Frame' : 'Main Page'}`);

        // ── Étape 1: Saisir le code (Booking Code ou Bet ID) ──
        const isBookingCode = mode === 'bookingcode' || (ticketId && ticketId.length <= 8);
        console.log(`[BIBEET] Strategy: ${isBookingCode ? 'Fast Code (Booking)' : 'Bet ID'} Mode`);

        const inputResult = await target.evaluate((tid, isBooking) => {
            // Sélecteurs pour Bibeet / Altenar
            const placeholders = isBooking ? 
                ['enter fast code', 'fast code', 'booking code', 'code rapide', 'entrez le code'] : 
                ['enter bet id', 'bet id', 'id du pari'];
            
            const allInputs = Array.from(document.querySelectorAll('input'));
            let inputEl = allInputs.find(inp => {
                const ph = (inp.placeholder || '').toLowerCase();
                return placeholders.some(p => ph.includes(p));
            });

            if (!inputEl) {
                inputEl = document.querySelector('input[class*="booking"], input[class*="fast"], input[class*="search-bets"]');
            }

            if (!inputEl && isBooking) {
                // Fallback: search by label or nearby text
                const labels = Array.from(document.querySelectorAll('label, span, div'));
                const bookingLabel = labels.find(l => l.innerText && l.innerText.toLowerCase().includes('booking'));
                if (bookingLabel) {
                    inputEl = bookingLabel.parentElement.querySelector('input') || bookingLabel.querySelector('input');
                }
            }

            if (!inputEl) return { ok: false, msg: 'Input non trouvé' };

            inputEl.scrollIntoView({ block: 'center' });
            inputEl.focus();
            
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inputEl, tid);
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // Valider
            const form = inputEl.closest('form');
            if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true }));
            } else {
                inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }

            return { ok: true, placeholder: inputEl.placeholder };
        }, String(ticketId), isBookingCode);

        if (!inputResult.ok) {
            // Second attempt: try to click the search icon first if it's Altenar WSDK
            await target.evaluate(() => {
                const icons = Array.from(document.querySelectorAll('[aria-label], [title], [class*="icon"]'));
                const searchIcon = icons.find(i => {
                    const label = (i.getAttribute('aria-label') || i.getAttribute('title') || '').toLowerCase();
                    return label.includes('check') || label.includes('search') || label.includes('ticket');
                });
                if (searchIcon) searchIcon.click();
            });
            await new Promise(r => setTimeout(r, 2000));
        }

        // ── Étape 2: Attendre le résultat ──
        console.log('[BIBEET] Waiting for result...');
        await new Promise(r => setTimeout(r, 8000));

        // ── Étape 3: Extraire les données ──
        const rawData = await target.evaluate(() => {
            const sels = [
                '[class*="ticket"]', '[class*="bet-detail"]', '[class*="betDetail"]',
                '[class*="coupon"]', '[class*="booking"]', '[class*="result"]',
                '[class*="slip"]', '[class*="asb"]', '.asb-flex-column'
            ];
            let text = '';
            sels.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    if (el.innerText && el.innerText.trim().length > 10) text += el.innerText.trim() + '\n';
                });
            });
            return text.trim() || document.body.innerText.substring(0, 5000);
        });

        // ── Étape 4: Parser ──
        const lower = rawData.toLowerCase();
        let status = 'En cours';
        if (lower.includes('won') || lower.includes('win') || lower.includes('gagné')) status = 'Gagné';
        else if (lower.includes('lost') || lower.includes('perdu')) status = 'Perdu';
        else if (lower.includes('cancel') || lower.includes('annul')) status = 'Annulé';
        
        let totalOdds = 1.0;
        const oddsMatches = rawData.match(/(\d+[,.]\d{2,3})/g);
        if (oddsMatches) {
            // Often the largest number that isn't a date or huge stake is the total odds
            const candidates = oddsMatches.map(m => parseFloat(m.replace(',', '.'))).filter(v => v > 1.05 && v < 10000);
            if (candidates.length > 0) totalOdds = Math.max(...candidates);
        }

        return res.json({
            success: true,
            tickets: [{
                id: ticketId,
                date: new Date().toISOString().split('T')[0],
                status,
                totalOdds,
                rawText: rawData.substring(0, 1500)
            }]
        });

    } catch (e) {
        console.error('[BIBEET SCRAPER ERROR]', e.message);
        return res.status(500).json({ error: e.message });
    } finally {
        if (browser) {
            try {
                const pages = await browser.pages();
                for (const p of pages) {
                    if (p.url() !== 'about:blank') await p.close();
                }
            } catch (e) { console.error('[SCRAPER] Error closing pages:', e.message); }
        }
    }
});

/**
 * GET /api/bibeet/today
 * Reads the latest Bibeet booking coupon scraped for today/tomorrow
 */
router.get('/bibeet/today', (req, res) => {
    try {
        const filePath = path.join(__dirname, '..', 'bibeet_tomorrow.json');
        if (!fs.existsSync(filePath)) {
            return res.json({ bookingCode: 'NOT_FOUND' });
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/bibeet/scrape
 * Triggers the script to scrape Bibeet coupons
 */
router.post('/bibeet/scrape', (req, res) => {
    try {
        const { exec } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'scripts', 'scrape_bibeet_tomorrow.js');
        
        exec(`node "${scriptPath}"`, { timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                console.error('[BIBEET SCRAPE ERROR]', stderr);
                return res.status(500).json({ error: error.message });
            }
            
            const filePath = path.join(__dirname, '..', 'bibeet_tomorrow.json');
            if (!fs.existsSync(filePath)) {
                return res.json({ bookingCode: 'NOT_FOUND' });
            }
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            res.json(data);
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── HELPERS: booking_codes.json ─────────────────────────────────────────────
const BOOKING_DB = path.join(__dirname, '..', 'data', 'booking_codes.json');

function loadBookingDB() {
    try {
        if (!fs.existsSync(BOOKING_DB)) return { codes: [] };
        return JSON.parse(fs.readFileSync(BOOKING_DB, 'utf8'));
    } catch { return { codes: [] }; }
}

function saveBookingDB(db) {
    db.meta = { lastUpdated: new Date().toISOString(), total: db.codes.length };
    fs.mkdirSync(path.dirname(BOOKING_DB), { recursive: true });
    fs.writeFileSync(BOOKING_DB, JSON.stringify(db, null, 2), 'utf8');
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * GET /api/booking-codes/all
 * Returns all booking codes: from booking_codes.json + bibeet_tomorrow.json
 */
router.get('/booking-codes/all', (req, res) => {
    try {
        const db = loadBookingDB();
        let codes = [...(db.codes || [])];

        // Merge Bibeet auto-scraper
        const bibeetFile = path.join(__dirname, '..', 'bibeet_tomorrow.json');
        if (fs.existsSync(bibeetFile)) {
            try {
                const bibeet = JSON.parse(fs.readFileSync(bibeetFile, 'utf8'));
                if (bibeet.bookingCode && bibeet.bookingCode !== 'NOT_FOUND') {
                    const alreadyIn = codes.some(c => c.code === bibeet.bookingCode && c.platform === 'Bibeet');
                    if (!alreadyIn) {
                        codes.unshift({
                            id: 'bibeet_auto',
                            platform: 'Bibeet',
                            code: bibeet.bookingCode,
                            channel: '🤖 Auto-Scraper',
                            description: `Scraped automatiquement — ${bibeet.forDate || ''}`,
                            matches: (bibeet.matches || []).slice(0, 5).map(m => `${m.home} vs ${m.away}`).join(', '),
                            status: 'active',
                            addedAt: bibeet.scrapedAt || new Date().toISOString(),
                        });
                    }
                }
            } catch (_) {}
        }

        // Sort newest first
        codes.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

        res.json({ success: true, codes, total: codes.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/booking-codes/add
 * Manually add a booking code to the DB
 * Body: { platform, code, channel, description, matches, status }
 */
router.post('/booking-codes/add', (req, res) => {
    try {
        const { platform, code, channel, description, matches, status } = req.body;
        if (!code || !code.trim()) return res.status(400).json({ error: 'code is required' });

        const db = loadBookingDB();
        const newEntry = {
            id:          uid(),
            platform:    platform || 'Manuel',
            code:        code.trim().toUpperCase(),
            channel:     channel || 'Manuel',
            description: description || '',
            matches:     matches || '',
            status:      status || 'active',
            addedAt:     new Date().toISOString(),
        };

        // Avoid duplicates
        const exists = db.codes.some(c => c.code === newEntry.code && c.platform === newEntry.platform);
        if (exists) return res.status(409).json({ error: 'Code already exists for this platform' });

        db.codes.unshift(newEntry);
        saveBookingDB(db);

        console.log(`[BOOKING] New code added: ${newEntry.platform} — ${newEntry.code}`);
        res.json({ success: true, entry: newEntry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /api/booking-codes/:id
 * Remove a code by ID
 */
router.delete('/booking-codes/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = loadBookingDB();
        const before = db.codes.length;
        db.codes = db.codes.filter(c => c.id !== id);
        if (db.codes.length === before) return res.status(404).json({ error: 'Code not found' });
        saveBookingDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * PATCH /api/booking-codes/:id
 * Update status or other fields of a code
 */
router.patch('/booking-codes/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = loadBookingDB();
        const idx = db.codes.findIndex(c => c.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Code not found' });
        db.codes[idx] = { ...db.codes[idx], ...req.body };
        saveBookingDB(db);
        res.json({ success: true, entry: db.codes[idx] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

