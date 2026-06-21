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
    console.log('Navigating...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));

    const text = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync('page_text.txt', text);
    console.log('Saved page text.');

    // Also let's check Cloudflare
    const title = await page.title();
    console.log('Page Title:', title);
    
    await browser.close();
})();
