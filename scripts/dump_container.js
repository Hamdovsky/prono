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
    console.log('Waiting 20s for full WSDK load...');
    await new Promise(r => setTimeout(r, 20000));

    const containerHTML = await page.evaluate(() => {
        const el = document.getElementById('altenar-container');
        return el ? el.innerHTML : 'No #altenar-container found';
    });
    
    fs.writeFileSync('container_dump.html', containerHTML);
    console.log('Dumped HTML to container_dump.html');

    await browser.close();
})();
