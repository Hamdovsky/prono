/**
 * scrape_bibeet_tomorrow.js
 * Bibeet Tomorrow Coupon Scraper — extracts tomorrow's matches + generates a Booking Code.
 * Technique: intercepts Altenar closed shadow root, clicks ReservationButton, extracts code from DOM.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTomorrowDateStr() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}`;           // e.g. "26/04"
}

function deduplicateMatches(matches) {
    const seen = new Set();
    return matches.filter(m => {
        const key = `${m.home}|${m.away}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function scrapeBibeetTomorrow() {
    const tomorrowStr = getTomorrowDateStr();
    console.log(`🚀 [BIBEET SCRAPER] Extracting matches for tomorrow (${tomorrowStr})...`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--window-size=1400,1000',
        ],
    });

    try {
        const page = await browser.newPage();

        // ── 1. Intercept Altenar closed shadow root before page loads ─────────
        await page.evaluateOnNewDocument(() => {
            const _orig = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function (opts) {
                const root = _orig.call(this, { ...opts, mode: 'open' });
                this._shadowRoot = root;
                return root;
            };
        });

        // ── 2. Listen for booking-code API responses ──────────────────────────
        let apiBookingCode = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (response.request().method() !== 'POST') return;
            if (!url.includes('/api/') && !url.includes('widget')) return;
            try {
                const json = await response.json();
                if (json?.bookingCode) apiBookingCode = json.bookingCode;
                else if (json?.shortCode)  apiBookingCode = json.shortCode;
                else if (typeof json?.code === 'string') apiBookingCode = json.code;
            } catch (_) {}
        });

        await page.setViewport({ width: 1400, height: 1000 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );

        // ── 3. Navigate ───────────────────────────────────────────────────────
        console.log('[BIBEET] Navigating...');
        await page.goto('https://bibeet.com/betting#/overview', {
            waitUntil: 'networkidle2',
            timeout: 60000,
        });

        console.log('[BIBEET] Waiting 15s for WSDK...');
        await new Promise((r) => setTimeout(r, 15000));

        // ── 4. Interact inside shadow root ────────────────────────────────────
        const matches = await page.evaluate(async (tomorrowStr) => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

            const shadow = document
                .getElementById('altenar-container')
                ?.querySelector('div')
                ?._shadowRoot;
            if (!shadow) return { error: 'shadow root not found' };

            // Click "Tomorrow" tab in the side-menu period filter
            const btns = Array.from(shadow.querySelectorAll('button'));
            const tomorrowBtn = btns.find((b) => b.innerText?.trim() === 'Tomorrow');
            if (tomorrowBtn) {
                tomorrowBtn.click();
                await sleep(5000);
            } else {
                console.warn('[BIBEET] Tomorrow button not found in sidebar');
            }

            // Click "Sun 26" (or whatever tomorrow's date tab is) in the top DateBar
            const dateTabBtns = Array.from(shadow.querySelectorAll('button[class*="DateBarTab"]'));
            // We look for a tab that shows tomorrow's day number
            const tomorrowDay = tomorrowStr.split('/')[0]; // "26"
            const dateTab = dateTabBtns.find((b) => {
                const dateSpan = b.querySelector('span[class*="DateBarDate"]');
                return dateSpan && dateSpan.innerText.trim() === tomorrowDay;
            });
            if (dateTab) {
                dateTab.click();
                await sleep(4000);
            }

            // ── Extract matches ──────────────────────────────────────────────
            const eventBoxes = Array.from(shadow.querySelectorAll('div[class*="EventBox"]'));
            const extracted = [];

            for (const box of eventBoxes) {
                const names = Array.from(
                    box.querySelectorAll('div[class*="CompetitorName"]')
                ).map((el) => el.innerText.trim());

                const oddBtns = Array.from(box.querySelectorAll('button[class*="OddBoxButton"]'));
                if (names.length < 2 || oddBtns.length < 3) continue;

                const rawOdds = oddBtns.slice(0, 3).map((el) => {
                    const label = el.querySelector('span[class*="OddLabel"]')?.innerText.trim();
                    const val   = el.querySelector('div[class*="OddValue"]')?.innerText.trim();
                    return { label: label || '?', value: val || '-' };
                });

                // Build structured 1 / X / 2
                const odds = {};
                for (const o of rawOdds) odds[o.label] = o.value;

                // Grab match time — strip any "BB" or "Live" prefix noise
                const timeEl = box.querySelector('div[class*="TimeBase"], div[class*="Time-sc"]');
                const dateEl = box.querySelector('div[class*="DateBase"], div[class*="Date-sc"]');
                const time   = (timeEl?.innerText || '').replace(/^BB\s*/i, '').trim();
                const date   = (dateEl?.innerText || '').replace(/^BB\s*/i, '').trim();

                extracted.push({ home: names[0], away: names[1], time, date, odds });
            }

            // ── Click first 3 odds to populate betslip ───────────────────────
            const allOddBtns = Array.from(shadow.querySelectorAll('button[class*="OddBoxButton"]'));
            let clicked = 0;
            for (const btn of allOddBtns) {
                if (clicked >= 3) break;
                if (btn.isConnected && !btn.disabled) {
                    btn.click();
                    await sleep(1200);
                    clicked++;
                }
            }

            // ── Click ReservationButton (bookmark icon in betslip) ───────────
            await sleep(1500);
            const reservationBtn = shadow.querySelector('button[class*="ReservationButton"]');
            if (reservationBtn) {
                reservationBtn.click();
                await sleep(3000);

                // If a secondary "Get Booking Code" button appears, click it
                const secondaryBtns = Array.from(shadow.querySelectorAll('button'));
                const getCodeBtn = secondaryBtns.find((b) =>
                    /get booking code|generate|reserve/i.test(b.innerText || '')
                );
                if (getCodeBtn) {
                    getCodeBtn.click();
                    await sleep(2000);
                }
            }

            return extracted;
        }, tomorrowStr);

        // ── 5. Handle errors ──────────────────────────────────────────────────
        if (matches?.error) {
            console.error('❌ Shadow root error:', matches.error);
            return;
        }

        // ── 6. Deduplicate & filter ───────────────────────────────────────────
        const uniqueMatches = deduplicateMatches(matches);
        // Filter: keep only matches with valid odds
        const validMatches = uniqueMatches.filter(
            (m) => m.odds['1'] !== '-' || m.odds['X'] !== '-' || m.odds['2'] !== '-'
        );

        console.log(`✅ [BIBEET] Found ${validMatches.length} unique valid matches.`);

        // ── 7. Grab booking code (API first, then DOM fallback) ───────────────
        let bookingCode = apiBookingCode;

        if (!bookingCode) {
            console.log('[BIBEET] Booking code not in API — scanning DOM...');
            bookingCode = await page.evaluate(() => {
                const shadow = document
                    .getElementById('altenar-container')
                    ?.querySelector('div')
                    ?._shadowRoot;
                if (!shadow) return null;

                // Known Altenar UI labels to exclude
                const EXCLUDED = new Set([
                    'BETSLIP','SINGLE','MULTIPLE','SYSTEM','LIVE','BB','OK',
                    'ALL','TODAY','BET','ID','RAPID','MODE','CLEAR','SIGN',
                    'HOME','AWAY','DRAW','OVER','UNDER'
                ]);
                const els = Array.from(shadow.querySelectorAll('span, div, p, strong, h1, h2, h3'));
                const codeEl = els.find((el) => {
                    // Must be a leaf node with no child elements
                    if (el.children.length > 0) return false;
                    const txt = (el.innerText || '').trim();
                    return (
                        txt.length >= 4 &&
                        txt.length <= 10 &&
                        /^[A-Z0-9]+$/.test(txt) &&
                        !EXCLUDED.has(txt)
                    );
                });
                return codeEl ? codeEl.innerText.trim() : null;
            });
        }

        // ── 8. Save results ───────────────────────────────────────────────────
        const result = {
            scrapedAt: new Date().toISOString(),
            forDate: tomorrowStr,
            bookingCode: bookingCode || 'NOT_FOUND',
            totalMatches: validMatches.length,
            matches: validMatches,
        };

        const outPath = path.join(__dirname, '..', 'bibeet_tomorrow.json');
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

        console.log(`\n📋 Results:`);
        console.table(validMatches.slice(0, 15));

        if (bookingCode) {
            console.log(`\n🔥 Booking Code: ${bookingCode}`);
        } else {
            console.warn(`\n⚠️  Booking code NOT generated — betslip may require login.`);
            await page.screenshot({ path: path.join(__dirname, '..', 'betslip_state.png') });
            console.log('📸 Screenshot saved: betslip_state.png');
        }

        console.log(`💾 Saved: ${outPath}`);
        return result;

    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    scrapeBibeetTomorrow().catch(console.error);
}

module.exports = { scrapeBibeetTomorrow };
