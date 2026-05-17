const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    
    // Intercept shadow root creation
    await page.evaluateOnNewDocument(() => {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
            console.log('Intercepted attachShadow for', this.tagName, 'mode:', options.mode);
            // Force open mode or just keep a reference
            const shadowRoot = originalAttachShadow.call(this, { ...options, mode: 'open' });
            this._shadowRoot = shadowRoot;
            return shadowRoot;
        };
    });

    page.on('console', msg => {
        if (msg.text().includes('attachShadow')) console.log('[PAGE]', msg.text());
    });

    console.log('Navigating...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));

    const html = await page.evaluate(() => {
        const el = document.getElementById('altenar-container');
        if (!el) return 'No container';
        const innerDiv = el.querySelector('div');
        if (!innerDiv) return 'No inner div';
        if (innerDiv._shadowRoot) {
            return innerDiv._shadowRoot.innerHTML;
        } else if (innerDiv.shadowRoot) {
            return innerDiv.shadowRoot.innerHTML;
        }
        return 'No shadow root intercepted or accessible';
    });
    
    fs.writeFileSync('shadow_dump2.html', html);
    console.log('Dumped intercepted shadow HTML to shadow_dump2.html');

    await browser.close();
})();
