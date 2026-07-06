const Database = require('better-sqlite3');
const db = new Database('data/historical_archive.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
tables.forEach(t => {
  console.log('TABLE:', t.name);
  const cols = db.prepare('PRAGMA table_info(' + t.name + ')').all();
  cols.forEach(c => console.log('  ', c.name, c.type));
  const count = db.prepare('SELECT COUNT(*) as cnt FROM ' + t.name).get();
  console.log('  Rows:', count.cnt);
  if (count.cnt > 0) {
    const sample = db.prepare('SELECT * FROM ' + t.name + ' LIMIT 1').get();
    console.log('  Sample:', JSON.stringify(sample));
  }
});
db.close();
