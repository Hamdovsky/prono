const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        await page.goto('https://www.flashscore.com/football/england/premier-league/results/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches[0];

        console.log(`Testing match: ${targetMatch.id}`);
        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        const statsTabHandle = await page.evaluateHandle(() => {
            return Array.from(document.querySelectorAll('a, div')).find(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return ['stats', 'statistics'].includes(text);
            });
        });

        if (statsTabHandle) {
            console.log("Clicking stats tab...");
            await statsTabHandle.click();
            await new Promise(r => setTimeout(r, 4000));

            await page.screenshot({ path: 'stats_page.png', fullPage: true });
            console.log("Screenshot saved to stats_page.png");

            // Try to dump some raw DOM structure around stats
            const domDump = await page.evaluate(() => {
                // Flashscore stats usually have a container, let's just find the text "Expected Goals (xG)" or "Ball Possession"
                const elements = Array.from(document.querySelectorAll('*'));
                const possessionEl = elements.find(e => e.innerText === 'Ball Possession' && e.children.length === 0);
                if (possessionEl) {
                    const parent = possessionEl.parentElement.parentElement; // Usually row container
                    return {
                        found: true,
                        html: parent.outerHTML
                    };
                }
                return { found: false };
            });
            console.log("DOM Dump:", JSON.stringify(domDump, null, 2));

        }
    } catch (e) {
        console.error(e);
    } finally {
        await core.close();
    }
}
test();
