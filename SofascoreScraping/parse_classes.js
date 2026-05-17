const fs = require('fs');

try {
    const raw = fs.readFileSync('stats_html_dump.json', 'utf16le');
    // Find where the JSON array starts
    const startIdx = raw.indexOf('[');
    if (startIdx !== -1) {
        const jsonStr = raw.substring(startIdx);
        const data = JSON.parse(jsonStr);
        data.forEach(d => {
            console.log(`\n--- ${d.term} ---`);
            // Extact classes from html string
            const classRegex = /class="([^"]+)"/g;
            let match;
            while ((match = classRegex.exec(d.html)) !== null) {
                console.log(`Class found: ${match[1]}`);
            }
        });
    } else {
        console.log("Could not find JSON array in output.");
    }
} catch (e) {
    console.error(e);
}
