const fs = require('fs');
const html = fs.readFileSync('archive_full.html', 'utf8');

// Search for any pattern like ?id= or ?num= or ?grille=
const paramRegex = /\?(\w+)=(\d+)/g;
const params = new Set();
let match;
while ((match = paramRegex.exec(html)) !== null) {
    params.add(match[1]);
}
console.log('Found parameters:', Array.from(params));

// Look for the string "851"
console.log('Contains 851:', html.includes('851'));
if (html.includes('851')) {
    const index = html.indexOf('851');
    console.log('Context around 851:', html.substring(index - 50, index + 50).replace(/\r?\n/g, ' '));
}
