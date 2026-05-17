const db = require('../core/database').db;
const rows = db.prepare("SELECT id, status, source FROM matches WHERE status IN ('FT','Finished','finished','FINISHED')").all();
console.log(`Found ${rows.length} finished matches.`);
rows.slice(0, 5).forEach(r => console.log(`- ${r.id}: ${r.status} (${r.source})`));
