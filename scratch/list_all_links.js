const fs = require('fs');
const html = fs.readFileSync('promosport_archive_links.html', 'utf8');

const linkRegex = /href="([^"]*)"/g;
let match;
const links = [];
while ((match = linkRegex.exec(html)) !== null) {
    links.push(match[1]);
}
console.log('Found', links.length, 'links');
console.log('Sample links:', links.slice(0, 50));
