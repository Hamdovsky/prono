// Regression test E68-bis / E68-ter : ReferenceError "Cannot access X before
// initialization". Ces crashes provenaient de const declarees APRES leur
// premiere utilisation DIRECTE dans le corps du composant (dead zone). Les
// tests unitaires classiques ne les attrapaient pas car ils testent les
// fonctions pures (matchAnalysis, dashboardFilters), pas le rendu.
//
// Approche : on analyse le corps du composant principal au TOP-LEVEL. Les
// fonctions locales (flechees) et leurs corps sont EXCLUS : une closure
// capture les const par reference et s'execute APRES le rendu complet, donc
// un usage y est legal meme avant declaration (c'est ce qui generait les faux
// positifs). On ne garde que les usages "immediats" : le code qui s'execute
// sequentiellement pendant le rendu.

const fs = jest.requireActual('fs') // setup.js mocke fs (readFileSync -> '{}')
const path = require('path')

const SRC = path.resolve(__dirname, '..', 'src')
const TARGETS = ['components/MatchCard.jsx', 'components/Dashboard.jsx']

// Supprime commentaires + contenu des chaines (simple/backtick/double).
function stripLiterals(line) {
  let out = ''
  let i = 0
  let inStr = null
  while (i < line.length) {
    const ch = line[i]
    if (inStr) {
      if (ch === '\\') { out += '  '; i += 2; continue }
      if (ch === inStr) { inStr = null; out += '"' }
      else out += ' '
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      out += '"'
    } else if (ch === '/' && line[i + 1] === '/') {
      break
    } else {
      out += ch
    }
    i++
  }
  return out
}

// Trouve l'indice de la ligne ou commence le composant principal.
function findComponentStart(lines) {
  return lines.findIndex(
    (l) =>
      /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{/.test(l) ||
      /^\s*function\s+[A-Za-z_$][\w$]*\s*\(/.test(l)
  )
}

// Marque les lignes "top-level" du composant. On compte les accolades : une
// fonction locale (const X = ... => {) ouvre un sous-scope dont le CORPS est
// exclu (une closure capture les const par reference et s'execute APRES le
// rendu, un usage avant declaration y est donc legal). Le JSX (return (...))
// reste top-level : c'est du code qui s'execute immediatement pendant le
// rendu, c'est la ou les dead zones font crasher.
function markTopLevel(bodyLines) {
  const flags = new Array(bodyLines.length).fill(true)
  let depth = 0
  let sigBraceConsumed = false

  bodyLines.forEach((raw, idx) => {
    const line = stripLiterals(raw)
    const opens = (line.match(/\{/g) || []).length
    const closes = (line.match(/\}/g) || []).length

    if (depth === 0) {
      flags[idx] = true
      if (opens > closes) {
        if (!sigBraceConsumed) {
          // 1ere accolade ouvrante = signature du composant. Son interieur
          // EST le corps top-level : on ne descend pas.
          sigBraceConsumed = true
          depth = opens - closes - 1
        } else {
          // Fonction locale : on descend dans son corps.
          depth = opens - closes
        }
      }
    } else {
      flags[idx] = false
      depth += opens - closes
      if (depth < 0) depth = 0
    }
  })
  return flags
}

// (getIndent inutilise : supprime)

// Extrait les noms de props de la signature (destructuration multi-lignes).
function collectParamNames(bodyLines) {
  const paramNames = new Set()
  const sigText = bodyLines.slice(0, 8).join('\n')
  const sigMatch = sigText.match(/=\s*\(\s*\{([\s\S]*?)\}\s*\)?\s*=>/)
  if (sigMatch) {
    sigMatch[1].split(',').forEach((p) => {
      const name = p.trim().split(/[=:]/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) paramNames.add(name)
    })
  }
  return paramNames
}

// Verifie qu'aucune const locale declaree dans le corps top-level n'est lue
// avant sa ligne de declaration (dans le code top-level seulement).
function checkDeadZones(bodyLines, _rel) {
  const top = markTopLevel(bodyLines)
  const paramNames = collectParamNames(bodyLines)

  const decls = {}
  const reDecl = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/

  // Passe 1 : declarations top-level.
  bodyLines.forEach((raw, idx) => {
    if (!top[idx]) return
    const line = stripLiterals(raw)
    const dm = line.match(reDecl)
    if (dm && !(dm[1] in decls)) decls[dm[1]] = idx
  })

  // Passe 2 : usages top-level avant declaration.
  const violations = []
  const seen = new Set()
  bodyLines.forEach((raw, idx) => {
    if (!top[idx]) return
    const line = stripLiterals(raw)
    const identRe = /\b([A-Za-z_$][\w$]*)\b/g
    let m
    while ((m = identRe.exec(line)) !== null) {
      const name = m[1]
      if (!(name in decls)) continue
      if (paramNames.has(name)) continue
      if (decls[name] > idx) {
        const key = `${name}@${idx}`
        if (seen.has(key)) continue
        seen.add(key)
        violations.push({ name, usedAt: idx + 1, declaredAt: decls[name] + 1 })
      }
    }
  })

  return violations
}

describe('dead zone detection (E68-bis/E68-ter regression)', () => {
  const loadBody = (rel) =>
    fs.readFileSync(path.join(SRC, rel), 'utf8').split(/\r?\n/)

  test.each(TARGETS)('%s : aucune const lue avant sa declaration', (rel) => {
    const lines = loadBody(rel)
    const compStart = findComponentStart(lines)
    expect(compStart).toBeGreaterThanOrEqual(0)

    const body = lines.slice(compStart)
    const violations = checkDeadZones(body, rel)

    if (violations.length > 0) {
      const detail = violations
        .slice(0, 15)
        .map((v) => `  - '${v.name}' lu ligne ${v.usedAt} mais declare ligne ${v.declaredAt}`)
        .join('\n')
      throw new Error(
        `Dead zone detectee dans ${rel} — ReferenceError au rendu :\n${detail}\n` +
          'Corriger : deplacer la declaration AVANT sa premiere utilisation.'
      )
    }
  })

  it('MatchCard : cornersLabel declare avant cornersParsed (cas E68-ter)', () => {
    const lines = loadBody('components/MatchCard.jsx')
    const declLine = lines.findIndex((l) => /^\s*const\s+cornersLabel\s*=/.test(l))
    const useLine = lines.findIndex(
      (l) => /cornersParsed\s*=\s*parseBetText\(cornersLabel\)/.test(l)
    )
    expect(declLine).toBeGreaterThanOrEqual(0)
    expect(useLine).toBeGreaterThanOrEqual(0)
    expect(declLine).toBeLessThan(useLine)
  })

  it('Dashboard : liveFilteredList declare avant liveFlatList (cas E68-bis)', () => {
    const lines = loadBody('components/Dashboard.jsx')
    const declLine = lines.findIndex((l) => /^\s*const\s+liveFilteredList\s*=/.test(l))
    const useLine = lines.findIndex(
      (l) => /liveFlatList\s*=.*buildGroupedByTime\(liveFilteredList\)/.test(l)
    )
    expect(declLine).toBeGreaterThanOrEqual(0)
    expect(useLine).toBeGreaterThanOrEqual(0)
    expect(declLine).toBeLessThan(useLine)
  })

  // Paires (composant, variable, pattern d'usage) a surveiller : ce sont les
  // const dont l'usage est calcule au top-level pendant le rendu. Une erreur
  // d'ordonnancement ici = ReferenceError au rendu. Ajouter une entree a
  // chaque nouvelle const top-level utilisee avant sa declaration potentielle.
  const CRITICAL_PAIRS = [
    {
      rel: 'components/MatchCard.jsx',
      decl: 'cornersLabel',
      use: 'cornersParsed\\s*=\\s*parseBetText\\(cornersLabel\\)',
    },
    {
      rel: 'components/MatchCard.jsx',
      decl: 'winnerDisplay',
      use: 'winParsed\\s*=\\s*parseBetText\\(winnerDisplay\\)',
    },
    {
      rel: 'components/Dashboard.jsx',
      decl: 'liveFilteredList',
      use: 'liveFlatList\\s*=.*buildGroupedByTime\\(liveFilteredList\\)',
    },
    {
      rel: 'components/Dashboard.jsx',
      decl: 'allMatchesList',
      use: 'flatList\\s*=.*buildGroupedByTime\\(allMatchesList\\)',
    },
  ]

  it.each(CRITICAL_PAIRS)(
    '$rel : "$decl" declare avant "$use"',
    ({ rel, decl, use }) => {
      const lines = loadBody(rel)
      const declLine = lines.findIndex((l) => new RegExp(`^\\s*const\\s+${decl}\\s*=`).test(l))
      const useLine = lines.findIndex((l) => new RegExp(use).test(l))
      expect(declLine).toBeGreaterThanOrEqual(0)
      expect(useLine).toBeGreaterThanOrEqual(0)
      expect(declLine).toBeLessThan(useLine)
    }
  )

  // Garde-fou : le test doit FAILLIR si on re-introduit la dead zone au
  // TOP-LEVEL (usage direct pendant le rendu, pas dans une closure).
  it('detecteur : signale bien une const placee apres usage', () => {
    const fakeBody = [
      'const C = () => {',
      '  const x = compute(b)', // usage TOP-LEVEL de b AVANT sa declaration
      '  const Inner = () => { return x }', // closure : usage de x est legal
      '  return x',
      '}',
      'const b = 2',
      'export default C',
    ]
    const v = checkDeadZones(fakeBody, 'fake')
    expect(v.some((x) => x.name === 'b')).toBe(true)
  })
})
