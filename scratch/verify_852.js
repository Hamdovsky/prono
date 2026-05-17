const fs = require('fs');
const html = fs.readFileSync('promosport_852_page.html', 'utf8');

const titleRegex = /Concours (?:International )?No (\d+)/i;
const titleMatch = html.match(titleRegex);
console.log('Title Match:', titleMatch ? titleMatch[0] : 'Not found');

const tableRegex = /<table id="tableau_classement"[^>]*>([\s\S]*?)<\/table>/;
const match = html.match(tableRegex);
if (match) {
    console.log('Found results table!');
    const rows = match[1];
    const rowRegex = /<tr><td>(\d+)<\/td><td class='equipe[^>]*>([\s\S]*?)<\/td><td class='equipe[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td class='result'>([^<]+)<\/td>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(rows)) !== null) {
        const team1 = rowMatch[2].replace(/<[^>]*>/g, '').trim();
        const team2 = rowMatch[3].replace(/<[^>]*>/g, '').trim();
        const result = rowMatch[4].trim();
        console.log(`${rowMatch[1]}: ${team1} vs ${team2} -> ${result}`);
    }
} else {
    console.log('Results table not found');
}
