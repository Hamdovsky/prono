const { SofaAPI } = require('../SofascoreScraping/src/apiClient');

async function checkDetails() {
    try {
        const details = await SofaAPI.getMatchDetails('14023957');
        if (details && details.event) {
            const e = details.event;
            console.log(`STATUS_TYPE:${e.status?.type}`);
            console.log(`STATUS_DESC:${e.status?.description}`);
            console.log(`START_TIME:${new Date(e.startTimestamp * 1000).toLocaleString()}`);
            console.log(`CURRENT_TIME:${new Date().toLocaleString()}`);
            
            // Calculate approximate minute from startTimestamp
            const diffMs = Date.now() - (e.startTimestamp * 1000);
            const diffMin = Math.floor(diffMs / 60000);
            console.log(`DIFF_MINUTES_FROM_START:${diffMin}`);
        }
    } catch (e) {
        console.error(e);
    }
}

checkDetails();
