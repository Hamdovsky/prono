const fs = require('fs');
const html = fs.readFileSync('promosport_851_page.html', 'utf8');

console.log('HTML Length:', html.length);
const index = html.indexOf('grille_result');
if (index !== -1) {
    console.log('Context around grille_result:', html.substring(index - 50, index + 150).replace(/\r?\n/g, ' '));
} else {
    console.log('grille_result not found');
}
