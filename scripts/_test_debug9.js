const fs = require('fs');
const html = fs.readFileSync('_f_table_debug.html', 'utf8');

const idPos = html.indexOf('id="f_table"');
const tableOpen = html.lastIndexOf('<table', idPos);
const tableClose = html.indexOf('</table>', idPos);
const tableHtml = html.substring(tableOpen, tableClose + 8);

// Find tr for match 9 (row 9 which is data row 8)
const trs = [];
let pos = 0;
while ((pos = tableHtml.indexOf('<tr', pos)) !== -1) {
  const trEnd = tableHtml.indexOf('</tr>', pos);
  if (trEnd === -1) break;
  trs.push(tableHtml.substring(pos, trEnd + 5));
  pos = trEnd + 5;
}

console.log('Total trs found:', trs.length);

// Check data row with match number 9 (should be around index 8-9)
for (let i = 1; i < trs.length; i++) {
  const row = trs[i];
  
  // Try the old p regex
  const oldMatch = row.match(/<p[^>]*style=['"][^'"]*text-align:\s*center[^'"]*['"][^>]*>\s*(?:<a[^>]*>\s*)?(\d+)\s*(?:<\/a>\s*)?<\/p>/i);
  
  // Try the new td regex
  const tdMatch = row.match(/<td[^>]*>\s*(\d{1,2})\s*<\/td>/i);
  
  if (oldMatch || tdMatch) {
    const id = parseInt((oldMatch || tdMatch)[1]);
    console.log('Tr ' + i + ': id=' + id + ' (from ' + (oldMatch ? 'p-regex' : 'td-regex') + ')');
  }
}
