const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        console.log("Navigating to Flashscore main page to find a finished match...");
        await page.goto('https://www.flashscore.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches.find(m => Extractor.classifyMatch(m.timeOrStatus) === 'finished' || m.timeOrStatus.toLowerCase().includes('ft'));

        if (!targetMatch) {
            console.log("No finished match on main page. Attempting to get yesterday's matches...");
            const prevDayBtn = await page.$('.calendar__navigation--yesterday');
            if (prevDayBtn) {
                await prevDayBtn.click();
                await new Promise(r => setTimeout(r, 4000));
                const oldMatches = await Extractor.getMatchList(page);
                targetMatch = oldMatches.find(m => Extractor.classifyMatch(m.timeOrStatus) === 'finished');
            }
        }

        if (!targetMatch) {
            console.log("Still no finished match found. Cannot test stats.");
            await core.close();
            return;
        }

        console.log(`Testing match: ${targetMatch.id} | ${targetMatch.home} vs ${targetMatch.away}`);

        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 2000));

        const statsTab = await page.$('a[href*="match-statistics"]');
        if (statsTab) {
            console.log("Clicking stats tab...");
            await statsTab.click();
            await new Promise(r => setTimeout(r, 2000));

            const details = await Extractor.getMatchDetails(page);
            console.log(`Extracted stats length: ${details.stats ? details.stats.length : 0}`);
            fs.writeFileSync('single_match_stats.json', JSON.stringify(details, null, 2));
            console.log("Saved to single_match_stats.json");
        } else {
            console.log("No stats tab found for this match.");
        }
    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await core.close();
    }
}
test();
