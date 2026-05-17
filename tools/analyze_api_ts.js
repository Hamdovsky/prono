const http = require('http');

http.get('http://127.0.0.1:5000/api/upcoming', (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const data = JSON.parse(body);
            console.log(`Received ${data.length} matches.`);
            
            const now = new Date();
            const todayStr = '2026-03-12';
            
            let countToday = 0;
            data.forEach(m => {
                const ts = m.startTimestamp || m.timestamp || m.startTime;
                let d;
                if (typeof ts === 'number') d = new Date(ts * 1000);
                else d = new Date(ts);
                
                if (d.toISOString().startsWith(todayStr)) {
                    countToday++;
                }
            });
            
            console.log(`Matches for Today (2026-03-12) in API response: ${countToday}`);
            
            if (data.length > 0) {
                const m = data[0];
                console.log('Sample Match IDs:', m.id, m.matchId);
                console.log('Sample Match Time Info:', {
                    startTimestamp: m.startTimestamp,
                    timestamp: m.timestamp,
                    startTime: m.startTime
                });
            }
        } catch (e) {
            console.log('Error:', e.message);
        }
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
