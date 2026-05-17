const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    // Suppress console logs from core
    console.log = function () { };
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        await page.goto('https://www.flashscore.com/football/england/premier-league/results/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Handle cookie banner
        const cookieBtn = await page.$('#onetrust-accept-btn-handler');
        if (cookieBtn) {
            await cookieBtn.click();
            await new Promise(r => setTimeout(r, 2000));
        }

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches[0];

        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        // Handle cookie banner again just in case
        const cookieBtn2 = await page.$('#onetrust-accept-btn-handler');
        if (cookieBtn2) {
            await cookieBtn2.click();
            await new Promise(r => setTimeout(r, 2000));
        }

        const statsTabHandle = await page.evaluateHandle(() => {
            return Array.from(document.querySelectorAll('a, div')).find(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return ['stats', 'statistics'].includes(text);
            });
        });

        if (statsTabHandle) {
            // Click with force to bypass overlays if any
            await statsTabHandle.click({ force: true });
            await new Promise(r => setTimeout(r, 4000));

            const dump = await page.evaluate(() => {
                const results = [];
                const searchStrings = ['Ball Possession', 'Goal Attempts', 'Corner Kicks', 'Fouls', 'Offsides'];

                searchStrings.forEach(str => {
                    const el = Array.from(document.querySelectorAll('div, span, strong')).find(e => e.innerText && e.innerText.trim() === str);
                    if (el) {
                        let parent = el.parentElement;
                        for (let i = 0; i < 2; i++) {
                            if (parent && parent.parentElement) parent = parent.parentElement;
                        }
                        results.push({
                            term: str,
                            html: parent.outerHTML
                        });
                    }
                });
                return results;
            });
            fs.writeFileSync('clean_stats_dump.json', JSON.stringify(dump, null, 2), 'utf8');
        }
    } catch (e) {
        fs.writeFileSync('clean_stats_dump_error.txt', e.message);
    } finally {
        await core.close();
    }
}
test();
