const fs = require('fs')
const html = fs.readFileSync('data/debug_grille_int.html', 'utf-8')
const gridSection = html.substring(34000, 50000)

// Look for the grid table with match data
const tableIdx = gridSection.indexOf('<table')
if (tableIdx >= 0) {
  const content = gridSection.substring(tableIdx, tableIdx + 4000).replace(/\n/g,' ').replace(/\s+/g,' ')
  console.log('Table content (first 2000 chars):')
  console.log(content.substring(0, 2000))
} else {
  console.log('No table found in section')
}

// Also look for team names
const names = ['Tunisie','Pays bas','Japon','Suede','Equateur','Allemagne']
for (const n of names) {
  const i = gridSection.indexOf(n)
  if (i >= 0) {
    console.log(`\n"${n}" at offset ${i}:`)
    console.log(gridSection.substring(Math.max(0,i-50), i+80))
  }
}
