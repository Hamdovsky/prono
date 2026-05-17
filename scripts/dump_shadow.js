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

    const shadowHTML = await page.evaluate(() => {
        const container = document.querySelector('#altenar-container > div');
        if (container && container.shadowRoot) {
            return container.shadowRoot.innerHTML;
        }
        return 'No shadow root found on #altenar-container > div';
    });
    
    fs.writeFileSync('shadow_dump.html', shadowHTML);
    console.log('Dumped shadow HTML to shadow_dump.html');

    const asbClasses = await page.evaluate(() => {
        function findAllInShadow(root, selector) {
            const results = [];
            const queue = [root];
            while (queue.length > 0) {
                const current = queue.shift();
                const matches = current.querySelectorAll(selector);
                matches.forEach(m => results.push(m.className));
                
                const all = current.querySelectorAll('*');
                for (const el of all) {
                    if (el.shadowRoot) queue.push(el.shadowRoot);
                }
            }
            return results;
        }
        return findAllInShadow(document, '[class*="wsdk-"]');
    });
    console.log('Found wsdk- classes count:', asbClasses.length);
    if(asbClasses.length > 0) {
        fs.writeFileSync('wsdk_classes.txt', [...new Set(asbClasses)].join('\n'));
        console.log('Saved unique classes to wsdk_classes.txt');
    }

    await browser.close();
})();
