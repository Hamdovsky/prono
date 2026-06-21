const db = require('./core/database').db;
console.log('Today memory count:', db.prepare("SELECT count(*) as c FROM learning_memory WHERE DATE(match_date) = DATE('now')").get().c);
console.log('Recent dates:', db.prepare("SELECT DATE(match_date) as d, count(*) as c FROM learning_memory GROUP BY d ORDER BY d DESC LIMIT 5").all());
