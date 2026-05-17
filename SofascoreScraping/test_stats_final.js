const ScraperCore = require('./src/ScraperCore');
const Extractor = require('./src/Extractor');

async function test() {
    console.log("Starting test for Extractor.getMatchDetails...");
    const core = new ScraperCore({ headless: true });
    // Suppress heavy logs
    console.log = function (msg) { process.stdout.write(msg + '\n'); };
    const context = await core.createContext();
    const page = await context.newPage();

    try {
        await page.goto('https://www.flashscore.com/football/england/premier-league/results/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000));

        // Handle cookie banner
        const cookieBtn = await page.$('#onetrust-accept-btn-handler').catch(() => null);
        if (cookieBtn) {
            await cookieBtn.click();
            await new Promise(r => setTimeout(r, 2000));
        }

        const matches = await Extractor.getMatchList(page);
        let targetMatch = matches[0];

        console.log(`Testing match: ${targetMatch.id}`);
        await page.goto(`https://www.flashscore.com/match/${targetMatch.id}/#/match-summary/`, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 4000));

        // Handle cookie banner again just in case
        const cookieBtn2 = await page.$('#onetrust-accept-btn-handler').catch(() => null);
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
            console.log("Clicking stats tab using evaluate...");
            await statsTabHandle.click({ force: true }).catch(() => { });
            await new Promise(r => setTimeout(r, 4000));

            const details = await Extractor.getMatchDetails(page);
            console.log("\n--- Extracted Stats ---");
            console.log(`Count: ${details.stats ? details.stats.length : 0}`);
            if (details.stats && details.stats.length > 0) {
                console.log(JSON.stringify(details.stats.slice(0, 5), null, 2));
                console.log("...SUCCESS ✓");
            } else {
                console.log("FAILED ✗ No stats extracted.");
            }
        } else {
            console.log("Stats tab not found.");
        }
    } catch (e) {
        console.error("Test error:", e);
    } finally {
        await core.close();
    }
}
test();
