const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

async function scrapeBibeet(ticketId, mode = 'bookingcode') {
    let browser;
    try {
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ];
        let executablePath;
        for (const p of chromePaths) {
            if (fs.existsSync(p)) { executablePath = p; break; }
        }

        browser = await puppeteer.launch({
            headless: 'new', executablePath,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--allow-running-insecure-content',
                '--window-size=1400,900'
            ]
        });

        const sportPage = await browser.newPage();
        await sportPage.setViewport({ width: 1400, height: 900 });
        await sportPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        console.log('[BIBEET] Loading parent page...');
        await sportPage.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log('[BIBEET] Waiting 10s for Altenar SDK...');
        await new Promise(r => setTimeout(r, 10000));

        const isBookingCode = mode === 'bookingcode' || ticketId.length <= 8;
        console.log(`[BIBEET] Strategy: ${isBookingCode ? 'Fast Code (Booking)' : 'Bet ID'} Mode`);

        const inputResult = await sportPage.evaluate((tid, isBooking) => {
            const placeholders = isBooking ? ['enter fast code', 'fast code', 'booking code'] : ['enter bet id', 'bet id'];
            
            const allInputs = Array.from(document.querySelectorAll('input'));
            let inputEl = allInputs.find(inp => {
                const ph = (inp.placeholder || '').toLowerCase();
                return placeholders.some(p => ph.includes(p));
            });

            if (!inputEl) {
                inputEl = document.querySelector('input[class*="booking"], input[class*="fast"], input[class*="search-bets"]');
            }

            if (!inputEl) {
                return { ok: false, msg: 'Input non trouvé', inputs: allInputs.map(i => i.placeholder) };
            }

            inputEl.scrollIntoView({ block: 'center' });
            inputEl.focus();
            
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(inputEl, tid);
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

            return { ok: true, placeholder: inputEl.placeholder, class: inputEl.className };

        }, String(ticketId), isBookingCode);

        console.log('[BIBEET] Input result:', inputResult);

        if (!inputResult.ok) throw new Error(`Erreur interaction Bibeet: ${inputResult.msg}`);

        console.log('[BIBEET] Waiting for result (10s)...');
        await new Promise(r => setTimeout(r, 10000));

        const rawData = await sportPage.evaluate(() => {
            const sels = ['[class*="ticket"]', '[class*="bet-detail"]', '[class*="coupon"]', '[class*="booking"]', '[class*="result"]', '[class*="slip"]', '[class*="asb"]'];
            let text = '';
            sels.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    if (el.innerText && el.innerText.trim().length > 6) text += el.innerText.trim() + '\n';
                });
            });
            return text.trim() || document.body.innerText.substring(0, 3000);
        });

        const result = { success: true, tickets: [{ id: ticketId, rawText: rawData.substring(0, 1500) }] };
        console.log("FINAL RESULT:");
        console.log(JSON.stringify(result, null, 2));

    } catch (e) {
        console.error('Error:', e);
    } finally {
        if (browser) await browser.close();
    }
}

scrapeBibeet('PWYJY', 'bookingcode');
