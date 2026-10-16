/**
 * E119 — historique des entraineurs Transfermarkt (parse pur, sans reseau :
 * le HTML est synthetise au format observe en production).
 */
const cheerio = require('cheerio')
const { parseManagerHistory, parseDmY } = require('../services/transfermarktService')

const html = `
<table class="items"><thead><tr>
<th>Name/Date of birth</th><th>Nat.</th><th>Appointed</th>
<th>End of time in post</th><th>Time in post</th><th>Matches</th><th>PPG</th>
</tr></thead><tbody>
<tr><td class="hauptlink"><a>Enzo Maresca</a></td>
<td class="zentriert"><img/></td><td class="zentriert">01/07/2026</td>
<td class="zentriert">-</td><td class="zentriert">107 days</td>
<td class="zentriert">10</td><td class="zentriert">2,40</td></tr>
<tr><td class="hauptlink"><a>Pep Guardiola</a></td>
<td class="zentriert"><img/></td><td class="zentriert">01/07/2016</td>
<td class="zentriert">30/06/2026</td><td class="zentriert">3651 days</td>
<td class="zentriert">593</td><td class="zentriert">2.27</td></tr>
<tr><td class="hauptlink"></td><td class="zentriert">x</td></tr>
<tr><td class="hauptlink"><a>Pep Guardiola</a></td>
<td class="zentriert"><img/></td><td class="zentriert">01/07/2016</td>
<td class="zentriert">30/06/2026</td><td class="zentriert">3651 days</td>
<td class="zentriert">593</td><td class="zentriert">2.27</td></tr>
</tbody></table>`

describe('parseManagerHistory (E119)', () => {
  it('extrait nom, dates ISO, current, matchs, ppg', () => {
    const out = parseManagerHistory(cheerio.load(html))
    expect(out.length).toBe(2) // parasite + doublon ecartes
    expect(out[0]).toMatchObject({
      name: 'Enzo Maresca', appointed: '2026-07-01', ended: null,
      current: true, matches: 10, ppg: 2.4,
    })
    expect(out[1]).toMatchObject({
      name: 'Pep Guardiola', appointed: '2016-07-01', ended: '2026-06-30',
      current: false, matches: 593, ppg: 2.27,
    })
  })

  it('rend null sans table staff', () => {
    expect(parseManagerHistory(cheerio.load('<html><body>vide</body></html>'))).toBeNull()
    expect(parseManagerHistory(cheerio.load('<table class="items"><thead><tr><th>Autre</th></tr></thead></table>'))).toBeNull()
  })
})

describe('parseDmY (E119)', () => {
  it('convertit JJ/MM/AAAA', () => {
    expect(parseDmY('01/07/2016')).toBe('2016-07-01')
  })

  it('rend null sur tirets, vide, invalide', () => {
    expect(parseDmY('-')).toBeNull()
    expect(parseDmY('')).toBeNull()
    expect(parseDmY(null)).toBeNull()
    expect(parseDmY('32/13/2020')).toBeNull()
    expect(parseDmY('2020-01-01')).toBeNull()
  })
})
