const smartComboEngine = require('../services/SmartComboEngine');

async function test() {
    console.log("Testing generateDailyTickets...");
    try {
        const tickets = await smartComboEngine.generateDailyTickets();
        console.log(JSON.stringify(tickets, null, 2));
    } catch (e) {
        console.error("Error:", e);
    }
}
test();
