const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');

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

            const dump = await page.evaluate(() => {
                const results = [];
                const searchStrings = ['Ball Possession', 'Goal Attempts', 'Corner Kicks', 'Fouls', 'Offsides'];

                searchStrings.forEach(str => {
                    const el = Array.from(document.querySelectorAll('div, span, strong')).find(e => e.innerText && e.innerText.trim() === str);
                    if (el) {
                        let parent = el.parentElement;
                        // Go up a few levels to get the whole row
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
            console.log(JSON.stringify(dump, null, 2));
        }
    } catch (e) {
        console.error(e);
    } finally {
        await core.close();
    }
}
test();
