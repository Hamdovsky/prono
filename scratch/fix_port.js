const fs = require('fs');
const path = require('path');

const botServicePath = path.resolve(__dirname, '../services/botService.js');
let code = fs.readFileSync(botServicePath, 'utf8');

code = code.replace(/process\.env\.SERVER_PORT \|\| 3001/g, 'process.env.PORT || process.env.SERVER_PORT || 3001');

fs.writeFileSync(botServicePath, code);
console.log('Fixed PORT issue in botService.js');
