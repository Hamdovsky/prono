const fs = require('fs');
const content = fs.readFileSync('v53_training_log.txt', 'utf16le');
const lines = content.split('\n').map(l => l.trim()).filter(l => l);

const accLine = lines.find(l => l.includes('[MODEL] V53 REHAB Accuracy'));
if (accLine) console.log(accLine);

const top10Index = lines.findIndex(l => l.includes('[V53-TOP10]'));
if (top10Index !== -1) {
    console.log(lines[top10Index]);
    lines.slice(top10Index + 1, top10Index + 11).forEach(l => console.log(l));
}
