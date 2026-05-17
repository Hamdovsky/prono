const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    page.on('console', msg => console.log(`[BROWSER] ${msg.text()}`));

    console.log('Navigating...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'domcontentloaded' });

    console.log('Waiting for shadow root to appear...');
    try {
        await page.waitForFunction(() => {
            const all = document.querySelectorAll('*');
            for (const el of all) {
                if (el.shadowRoot) return true;
                if (el.tagName.toLowerCase().includes('altenar')) return true;
            }
            return false;
        }, { timeout: 60000, polling: 1000 });
        
        console.log('Shadow root or altenar tag found!');
        
        const info = await page.evaluate(() => {
            const all = document.querySelectorAll('*');
            const shadows = [];
            const tags = [];
            for (const el of all) {
                if (el.shadowRoot) shadows.push(el.tagName.toLowerCase());
                if (el.tagName.toLowerCase().includes('altenar')) tags.push(el.tagName.toLowerCase());
            }
            return { shadows, tags };
        });
        console.log('Info:', info);
        
    } catch (e) {
        console.log('Timeout waiting for shadow root.');
    }

    await browser.close();
})();
