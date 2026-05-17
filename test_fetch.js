async function test() {
    const url = 'https://www.sofascore.com/api/v1/sport/football/scheduled-events/2026-04-25';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://www.sofascore.com/'
    };
    
    console.log(`Testing ${url}...`);
    try {
        const response = await fetch(url, { headers });
        console.log(`Status: ${response.status}`);
        if (response.ok) {
            const data = await response.json();
            console.log(`Success! Events count: ${data.events?.length}`);
        } else {
            console.log(`Failed with status ${response.status}`);
        }
    } catch (e) {
        console.error(`Error: ${e.message}`);
    }
}

test();
