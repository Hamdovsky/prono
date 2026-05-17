const { SofaAPI } = require('./src/apiClient');

async function diagnostic() {
    console.log('--- SCANNER DIAGNOSTIC START ---');
    const date = new Date().toISOString().split('T')[0];
    console.log(`📡 Testing scheduled events fetch for: ${date}`);
    
    try {
        const data = await SofaAPI.getEvents(date);
        if (data && data.events) {
            console.log(`✅ SUCCESS! Found ${data.events.length} events for ${date}`);
            if (data.events.length > 0) {
                console.log(`📍 First match: ${data.events[0].homeTeam?.name} vs ${data.events[0].awayTeam?.name}`);
            }
        } else {
            console.log('❌ FAILED: Response does not contain events property.');
            console.log('Data received:', JSON.stringify(data).substring(0, 200));
        }
    } catch (err) {
        console.error('❌ CRITICAL ERROR during fetch:', err.message);
        console.error('Stack trace:', err.stack);
    }
    console.log('--- SCANNER DIAGNOSTIC END ---');
}

diagnostic();
