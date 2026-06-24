const database = require('../core/database')
async function main() {
  const cols = await database.prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='matches' AND (column_name LIKE '%predict%' OR column_name LIKE '%score%' OR column_name LIKE '%confidence%' OR column_name LIKE '%verdict%')").all()
  console.log(cols.map(r => r.column_name + ' (' + r.data_type + ')').join('\n'))
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
