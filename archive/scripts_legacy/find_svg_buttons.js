const fs = require('fs');
const html = fs.readFileSync('betslip_shadow.html', 'utf8');

const regex = /<button[^>]*>([\s\S]*?)<\/button>/gi;
let match;
while ((match = regex.exec(html)) !== null) {
    if (match[1].includes('<svg')) {
        console.log('--- SVG Button Found ---');
        console.log(match[0]);
    }
}
