const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    const context = await core.createContext();
    const page = await context.newPage();

    // Choose a known finished match ID. For testing, any recent big match will do.
    // Let's go to flashscore main page, wait for hydration, grab ANY finished match on screen.
    // If not, we'll try a hardcoded ID from the stats_result list if it had any. (But they were all PRE_MATCH).
    // Let's just click 'results' on the first league and get the first match.

    try {
        console.log("Navigating to Flashscore main page...");
        await page.goto('https://www.flashscore.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Find a league link that says 'Premier League' or similar, click it, then click 'Results'
        // Alternatively, finding a finished match directly is tricky if there are none today.
        // Let's use a hardcoded match ID that we know is finished. 
        // e.g. a recent Premier League match: Chelsea vs somebody or Arsenal vs somebody. 
        // Let's fetch https://www.flashscore.com/football/england/premier-league/results/ again but scroll down?
        // Actually, let's use a dynamic search: 
        await page.goto('https://www.flashscore.com/football/england/premier-league-2023-2024/results/', { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches.find(m => Extractor.classifyMatch(m.timeOrStatus) === 'finished' || m.timeOrStatus.toLowerCase().includes('ft'));

        if (!targetMatch) {
            console.log("No finished match found on 23/24 results page.");
            await core.close();
            return;
        }

        console.log(`Testing match: ${targetMatch.id} | ${targetMatch.home} vs ${targetMatch.away}`);

        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        console.log("Checking available tabs on the page...");
        const tabs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a, div')).filter(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return ['stats', 'statistics', 'statistiques'].includes(text);
            }).map(el => ({
                text: el.innerText.trim(),
                className: el.className,
                href: el.getAttribute('href') || ''
            }));
        });
        console.log("Found stats tabs candidates:", JSON.stringify(tabs, null, 2));

        const statsTabHandle = await page.evaluateHandle(() => {
            return Array.from(document.querySelectorAll('a, div')).find(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return ['stats', 'statistics'].includes(text);
            });
        });

        // Test Extractor before clicking
        const detailsBefore = await Extractor.getMatchDetails(page);
        console.log(`Extracted stats length BEFORE clicking: ${detailsBefore.stats ? detailsBefore.stats.length : 0}`);

        if (statsTabHandle) {
            console.log("Clicking stats tab candidate...");
            await statsTabHandle.click();
            await new Promise(r => setTimeout(r, 3000));

            const detailsAfter = await Extractor.getMatchDetails(page);
            console.log(`Extracted stats length AFTER clicking: ${detailsAfter.stats ? detailsAfter.stats.length : 0}`);
            fs.writeFileSync('single_match_stats.json', JSON.stringify(detailsAfter, null, 2));
            console.log("Saved to single_match_stats.json");
        } else {
            console.log("No stats tab found by text.");
        }

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await core.close();
    }
}
test();
