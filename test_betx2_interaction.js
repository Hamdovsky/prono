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
        
        console.log('Finding target frame...');
        let targetFrame = null;
        for (const frame of page.frames()) {
            const hasInputs = await frame.$$('input');
            if (hasInputs.length > 0) {
                targetFrame = frame;
                console.log('Found frame with URL:', frame.url());
                break;
            }
        }
        
        const frame = targetFrame || page;

        console.log('Clicking "Coupon de pari" / "VÉRIFICATEUR DE COUPON"...');
        const couponBtnClicked = await frame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span'));
            // Try to find the VÉRIFICATEUR DE COUPON first
            let btn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('vérificateur de coupon') && b.getBoundingClientRect().width > 0);
            if (!btn) {
                btn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('coupon de pari') && b.getBoundingClientRect().width > 0);
            }
            if (btn) { btn.click(); return true; }
            return false;
        });
        console.log('Clicked?', couponBtnClicked);

        await new Promise(r => setTimeout(r, 2000));
        
        const inputs = await frame.$$('input');
        console.log(`Found ${inputs.length} inputs in frame after click`);
        
        let foundInput = false;
        for (const input of inputs) {
            const isVisible = await input.evaluate(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0;
            });
            if (isVisible) {
                console.log('Found visible input! Typing ticket...');
                await input.type("84920394");
                foundInput = true;
                break;
            }
        }
        
        console.log('Found input?', foundInput);
        
        if (foundInput) {
            const confirmBtnClicked = await frame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, div, span'));
                const btn = btns.find(b => b.textContent && (b.textContent.toLowerCase().includes('confirmer') || b.textContent.toLowerCase().includes('vérifier') || b.textContent.toLowerCase().includes('check')) && b.getBoundingClientRect().width > 0);
                if (btn) { btn.click(); return true; }
                return false;
            });
            console.log('Clicked confirm/check button?', confirmBtnClicked);
            
            if (!confirmBtnClicked) {
                await page.keyboard.press('Enter');
            }
            
            await new Promise(r => setTimeout(r, 5000));
            
            const resultData = await frame.evaluate(() => {
                return document.body.innerText;
            });
            console.log('Result length:', resultData.length);
            console.log('Result preview:', resultData.substring(0, 500));
            
            await page.screenshot({ path: 'betx2_result.png', fullPage: true });
        }
        
    } catch (e) {
        console.error('Error:', e);
    } finally {
        if (browser) await browser.close();
    }
})();
