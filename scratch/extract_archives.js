const fs = require('fs');
const html = fs.readFileSync('promosport_archive_list.html', 'utf8');

console.log('HTML Length:', html.length);
// Check first 1000 chars
console.log('First 1000 chars:', html.substring(0, 1000).replace(/\r?\n/g, ' '));

const selectRegex = /<select/i;
console.log('Contains <select:', selectRegex.test(html));

const optionRegex = /<option/i;
console.log('Contains <option:', optionRegex.test(html));
