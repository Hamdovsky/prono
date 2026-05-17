const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function checkTicket() {
    console.log('Launching browser...');
    const fs = require('fs');
    let executablePath = '';
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            executablePath = p;
            break;
        }
    }

    const browser = await puppeteer.launch({
        headless: "new",
        executablePath: executablePath || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    // Enable network request interception
    await page.setRequestInterception(true);
    
    page.on('request', request => {
        if (request.resourceType() === 'xhr' || request.resourceType() === 'fetch') {
            console.log('XHR/FETCH REQUEST URL:', request.url());
            if (request.method() === 'POST') {
                console.log('POST DATA:', request.postData());
            }
        }
        request.continue();
    });

    page.on('response', async response => {
        const req = response.request();
        if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
            const url = response.url();
            console.log('XHR/FETCH RESPONSE URL:', url);
            if (url.includes('api') || url.includes('ticket') || url.includes('slip') || url.includes('bet')) {
                try {
                    const text = await response.text();
                    console.log('RESPONSE BODY (first 200 chars):', text.substring(0, 200));
                } catch (e) {}
            }
        }
    });

    try {
        console.log('Navigating to betx2...');
        await page.goto('https://betx2.com/fr/sport', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Page loaded.');
        
        console.log('Looking for COUPON DE PARI...');
        const couponBtnClicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span'));
            const btn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('coupon de pari'));
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });

        if (couponBtnClicked) {
            console.log('Clicked COUPON DE PARI button.');
            await new Promise(r => setTimeout(r, 2000));
        } else {
            console.log('Could not find COUPON DE PARI by text, trying to click at bottom right...');
            await page.mouse.click(1300, 700); 
            await new Promise(r => setTimeout(r, 2000));
        }

        console.log('Looking for N° d\'Enregistrement input...');
        const inputs = await page.$$('input[type="text"]');
        let foundInput = false;
        for (const input of inputs) {
            const isVisible = await input.evaluate(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0;
            });
            if (isVisible) {
                console.log('Found visible input, typing ticket ID...');
                await input.type('84920394');
                foundInput = true;
                break;
            }
        }

        if (!foundInput) {
            console.log('Could not find visible input. Taking screenshot.');
            await page.screenshot({path: 'scratch/error_input_not_found.png'});
        } else {
            console.log('Looking for Confirmer button...');
            const confirmBtnClicked = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const btn = btns.find(b => b.textContent && b.textContent.toLowerCase().includes('confirmer'));
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            });
            
            if (confirmBtnClicked) {
                console.log('Clicked Confirmer...');
            } else {
                console.log('Could not find Confirmer by text. Pressing Enter...');
                await page.keyboard.press('Enter');
            }
            await new Promise(r => setTimeout(r, 5000));
        }
        
    } catch (e) {
        console.error('Error during execution:', e);
    } finally {
        console.log('Closing browser...');
        await browser.close();
    }
}

checkTicket();
