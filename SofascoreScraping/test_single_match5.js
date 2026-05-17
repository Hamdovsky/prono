const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');
const fs = require('fs');

async function test() {
    const core = new ScraperCore({ headless: true });
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        console.log("Navigating to Flashscore yesterday's matches...");
        // Flashscore doesn't use ?d=-1 anymore like that in new UI sometimes.
        // But doing /football/england/premier-league/results/ should still work. The issue might be that Extractor is failing to get matches there.
        // Let's debug Extractor.getMatchList on the results page.

        await page.goto('https://www.flashscore.com/football/england/premier-league/results/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        const content = await page.content();
        fs.writeFileSync('page_debug.html', content);

        const matches = await Extractor.getMatchList(page);
        console.log(`Found ${matches.length} matches on results page.`);
        let targetMatch = matches.find(m => Extractor.classifyMatch(m.timeOrStatus) === 'finished' || m.timeOrStatus.toLowerCase().includes('ft') || m.timeOrStatus.toLowerCase().includes('finished'));

        if (!targetMatch) {
            // For results page, all matches are finished. Let's just take the first one if there are any.
            if (matches.length > 0) {
                targetMatch = matches[0];
            } else {
                console.log("No match found at all.");
                await core.close();
                return;
            }
        }

        console.log(`Testing match: ${targetMatch.id} | ${targetMatch.home} vs ${targetMatch.away}`);

        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        const tabs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a, div')).filter(el => {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : '';
                return ['stats', 'statistics'].includes(text);
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
