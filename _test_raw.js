const fs = require('fs');
const html = fs.readFileSync('_f_table_debug.html', 'utf8');
const rows = html.split('</tr>');
for (let i = 8; i < 13; i++) {
  const row = rows[i] || '';
  const firstTd = row.match(/<td[^>]*>([\s\S]*?)<\/td>/);
  if (firstTd) {
    const raw = firstTd[1];
    console.log('Row ' + i + ' raw td=' + JSON.stringify(raw.substring(0, 200)));
  } else {
    console.log('Row ' + i + ' no td match, snippet=' + JSON.stringify(row.substring(0, 150)));
  }
}
