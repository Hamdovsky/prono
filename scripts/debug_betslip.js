const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--window-size=1400,1000'
        ]
    });
    
    const page = await browser.newPage();
    
    // Intercept shadow root
    await page.evaluateOnNewDocument(() => {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) {
            const shadowRoot = originalAttachShadow.call(this, { ...options, mode: 'open' });
            this._shadowRoot = shadowRoot;
            return shadowRoot;
        };
    });

    await page.setViewport({ width: 1400, height: 1000 });
    
    console.log('Navigating to Bibeet...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
    
    console.log('Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));

    await page.evaluate(async () => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const shadow = document.getElementById('altenar-container').querySelector('div')._shadowRoot;
        
        const firstOdd = shadow.querySelector('button[class*="OddBoxButton"]');
        if (firstOdd) {
            console.log('Clicking odd...');
            firstOdd.click();
            await sleep(4000); // Wait for betslip to animate
        }
    });

    console.log('Taking screenshot of betslip...');
    await page.screenshot({ path: 'betslip_debug.png' });

    const shadowHTML = await page.evaluate(() => {
        return document.getElementById('altenar-container').querySelector('div')._shadowRoot.innerHTML;
    });

    fs.writeFileSync('betslip_shadow.html', shadowHTML);
    console.log('Dumped shadow HTML with betslip open');

    await browser.close();
})();
