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
    
    const logs = [];
    page.on('response', response => {
        logs.push(`${response.status()} ${response.url()}`);
    });
    
    console.log('Navigating...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));

    fs.writeFileSync('network_logs.txt', logs.join('\n'));
    console.log('Saved network logs to network_logs.txt');
    
    await browser.close();
})();
