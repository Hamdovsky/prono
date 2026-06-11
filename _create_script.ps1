const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function inspect(path, name) {
  if (!fs.existsSync(path)) { console.log(name + ' not found'); return; }
  console.log('=== ' + name + ' ===');
  const db = new Database(path);
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  for (const t of tables) {
    console.log('\nTABLE: ' + t.name);
    if (t.sql) {
      const lines = t.sql.split('\n');
      console.log(lines.slice(0, 8).join('\n'));
    }
    try { console.log('  Rows: ' + db.prepare('SELECT COUNT(*) as c FROM "' + t.name + '"').get().c); } catch(e) { console.log('  Rows: error'); }
  }
  db.close();
}

inspect(path.join(__dirname, 'data', 'historical_archive.sqlite'), 'historical_archive.sqlite');
console.log('\n\n');
inspect(path.join(__dirname, 'data', 'tactical.db'), 'tactical.db');
" | Out-File -FilePath _inspect.js -Encoding ASCII -NoNewline