const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    console.log('Navigating...');
    await page.goto('https://bibeet.com/betting#/overview', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('Waiting 15s...');
    await new Promise(r => setTimeout(r, 15000));

    console.log('Dumping frames:');
    function dumpFrameTree(frame, indent = '') {
        console.log(indent + frame.url());
        for (const child of frame.childFrames()) {
            dumpFrameTree(child, indent + '  ');
        }
    }
    dumpFrameTree(page.mainFrame());
    
    console.log('Checking for altenar-sportsbook tag...');
    const altenarCount = await page.evaluate(() => document.querySelectorAll('altenar-sportsbook').length);
    console.log('altenar-sportsbook count:', altenarCount);
    
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const fs = require('fs');
    fs.writeFileSync('bibeet_debug.html', html);
    console.log('Dumped full HTML to bibeet_debug.html');

    await page.screenshot({ path: 'bibeet_debug_screen.png', fullPage: true });
    console.log('Saved screenshot to bibeet_debug_screen.png');

    await browser.close();
})();


