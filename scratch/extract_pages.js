const fs = require('fs');
const html = fs.readFileSync('promosport_archive_links.html', 'utf8');

const pageRegex = /page=(\d+)/g;
const pages = new Set();
let match;
while ((match = pageRegex.exec(html)) !== null) {
    pages.add(parseInt(match[1]));
}
console.log('Pages found:', Array.from(pages).sort((a,b) => a-b));
