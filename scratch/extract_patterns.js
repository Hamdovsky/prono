const fs = require('fs');
const path = require('path');

const filePath = path.join('c:/Users/HAMDI/Desktop/HamdiProno/stitch/data/fpis_learning_log.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const types = new Set();
data.forEach(entry => {
    if (entry.match_type) types.add(entry.match_type);
});

console.log('Detected Match Patterns:', Array.from(types));
