const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        console.log("Navigating to Premier League results...");
        await page.goto('https://www.flashscore.com/football/england/premier-league/results/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches.find(m => Extractor.classifyMatch(m.timeOrStatus) === 'finished' || m.timeOrStatus.toLowerCase().includes('ft'));

        if (!targetMatch) {
            console.log("No finished match found on results page.");
            await core.close();
            return;
        }

        console.log(`Testing match: ${targetMatch.id} | ${targetMatch.home} vs ${targetMatch.away}`);

        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        console.log("Checking available tabs on the page...");
        const tabs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.tabs__tab, a.tab, [role="tab"], .filter__item')).map(el => ({
                text: el.innerText.trim(),
                classes: el.className,
                href: el.getAttribute('href')
            }));
        });
        console.log("Found tabs:", JSON.stringify(tabs, null, 2));

        // Try clicking a tab that contains "Stats"
        const statsTabHandle = await page.evaluateHandle(() => {
            return Array.from(document.querySelectorAll('a, div')).find(el => el.innerText && el.innerText.trim().toLowerCase() === 'stats');
        });

        if (statsTabHandle) {
            console.log("Found something that looks like a stats tab by text, clicking it...");
            await statsTabHandle.click();
            await new Promise(r => setTimeout(r, 3000));

            const details = await Extractor.getMatchDetails(page);
            console.log(`Extracted stats length: ${details.stats ? details.stats.length : 0}`);
            fs.writeFileSync('single_match_stats.json', JSON.stringify(details, null, 2));
            console.log("Saved to single_match_stats.json");
        } else {
            console.log("No stats tab found by text.");
            await page.screenshot({ path: 'match_page_debug.png' });
            console.log("Saved screenshot to match_page_debug.png");
        }

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await core.close();
    }
}
test();
