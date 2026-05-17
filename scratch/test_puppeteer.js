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
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            executablePath = p;
            break;
        }
    }
    const browser = await puppeteer.launch({ headless: 'new', executablePath });
    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36');
    
    console.log('Navigating to betx2...');
    try {
        await page.goto('https://betx2.com/fr/sport', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Page loaded!');
        
        // Let's get the page title and search for ticket inputs
        const title = await page.title();
        console.log('Title:', title);
        
        // Dump the body HTML
        const html = await page.content();
        const fs = require('fs');
        fs.writeFileSync('scratch/betx2_html_dump.html', html);
        console.log('HTML dumped to scratch/betx2_html_dump.html. Length:', html.length);
        
    } catch (e) {
        console.error('Error during scraping:', e);
    } finally {
        await browser.close();
    }
}

checkTicket();
