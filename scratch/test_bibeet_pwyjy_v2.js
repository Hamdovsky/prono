const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

async function test() {
    let browser;
    try {
        console.log('[DEBUG] Launching browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        
        console.log('[DEBUG] Loading Bibeet...');
        await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'domcontentloaded' });
        
        console.log('[DEBUG] Waiting for SDK (10s)...');
        await new Promise(r => setTimeout(r, 10000));

        console.log('[DEBUG] Searching for input...');
        const result = await page.evaluate((tid) => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const input = inputs.find(i => {
                const ph = (i.placeholder || '').toLowerCase();
                return ph.includes('fast code') || ph.includes('booking code');
            });

            if (!input) return { ok: false, phs: inputs.map(i => i.placeholder) };

            input.value = tid;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            
            return { ok: true, ph: input.placeholder };
        }, 'PWYJY');

        console.log('[DEBUG] Input Result:', result);

        if (result.ok) {
            console.log('[DEBUG] Waiting for ticket (7s)...');
            await new Promise(r => setTimeout(r, 7000));
            
            const content = await page.evaluate(() => {
                return document.body.innerText.substring(0, 2000);
            });
            console.log('[DEBUG] Page Content Snippet:', content.substring(0, 500));
        }

    } catch (e) {
        console.error('[ERROR]', e);
    } finally {
        if (browser) await browser.close();
        console.log('[DEBUG] Done.');
    }
}

test();
