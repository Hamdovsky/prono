const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    let browser;
    try {
        console.log('Launching browser...');
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        
        console.log('Navigating to BetX2...');
        await page.goto('https://betx2.com/fr/sport', { waitUntil: 'networkidle2', timeout: 30000 });
        
        console.log('Taking screenshot...');
        await page.screenshot({ path: 'betx2_home.png', fullPage: true });

        console.log('Finding iframes...');
        const iframes = await page.$$('iframe');
        console.log(`Found ${iframes.length} iframes`);
        
        for (let i = 0; i < iframes.length; i++) {
            const frame = await iframes[i].contentFrame();
            if (frame) {
                console.log(`Frame ${i} URL: ${frame.url()}`);
                const inputs = await frame.$$('input');
                console.log(`  Inputs in frame ${i}: ${inputs.length}`);
                
                const buttons = await frame.$$eval('button, div', els => 
                    els.map(e => e.innerText).filter(t => t && t.toLowerCase().includes('coupon')).slice(0, 5)
                );
                console.log(`  Buttons with 'coupon' in frame ${i}:`, buttons);
            }
        }
    } catch (e) {
        console.error('Error:', e);
    } finally {
        if (browser) await browser.close();
    }
})();
