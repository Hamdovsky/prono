const fs = require('fs');
const html = fs.readFileSync('promosport_archive_links.html', 'utf8');

const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>(Concours No \d+)<\/a>/g;
let match;
console.log('Searching for Concours links...');
while ((match = linkRegex.exec(html)) !== null) {
    console.log(`  Link: ${match[1]}, Text: ${match[2]}`);
}
