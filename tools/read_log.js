const fs = require('fs');
const content = fs.readFileSync('v53_training_log.txt', 'utf16le');
const lines = content.split('\n');
console.log("LAST 100 LINES OF TRAINING LOG:");
lines.slice(-100).forEach(l => console.log(l.trim()));
