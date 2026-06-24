const database = require('../core/database')
async function main() {
  const cols = await database.prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='matches'").all()
  console.log(cols.map(r => r.column_name).join('\n'))
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
