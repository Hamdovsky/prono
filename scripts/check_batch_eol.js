/**
 * check_batch_eol.js — verrou anti-régression LF-only des fichiers .bat/.cmd
 *
 * POURQUOI (E103) : `cmd.exe` ne reconnaît pas LF comme fin de ligne. Un .bat
 * LF-only est lu comme UNE SEULE commande, decoupe sur espaces / '(' / ')' :
 * chaque ligne du script est executee comme un fragment. Resultat : des
 * dizaines de `'xxx' n'est pas reconnu en tant que commande interne` et, pire,
 * les etapes 1 a 4 du script ne tournent PLUS du tout (arret des services,
 * verification du venv, `cd /d`, variables d'environnement).
 *
 * Symptome reel : sans `set FASTAPI_ALLOW_UNAUTH=1`, `/predict` repondait 503.
 *
 * Aucun message d'erreur ne signale le probleme : le script "demarre" et les
 * services demarrent... avec un environnement incomplet. D'ou ce verrou.
 *
 * Usage : node scripts/check_batch_eol.js   (exit 1 si au moins un fichier LF-only)
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXTENSIONS = ['.bat', '.cmd']

// Repertoires exclus : dependances, environnements virtuels, worktrees,
// fichiers de build. Un .bat la est produit par un outil, pas ecrit a la main.
const EXCLUDED = [
  'node_modules',
  '.venv',
  '.venv-crawl4ai',
  '.kilo',
  '.opencode',
  '.git',
  'coverage',
  'dist',
  'build',
  '.agents',
]

function isExcluded(relPath) {
  return EXCLUDED.some((seg) => relPath.split(path.sep).includes(seg))
}

function collectBatchFiles(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (_) {
    return acc
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!isExcluded(path.relative(ROOT, full))) collectBatchFiles(full, acc)
    } else if (EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      if (!isExcluded(path.relative(ROOT, full))) acc.push(full)
    }
  }
  return acc
}

/** Analyse au niveau OCTET : on ne décode pas, on ne risque donc pas de
 *  corrompre l'encodage (les .bat contiennent des accents). */
function analyze(file) {
  const buf = fs.readFileSync(file)
  let lf = 0
  let crlf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lf++
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
    }
  }
  // Fichier sans aucune fin de ligne : rien a corriger.
  const isLfOnly = lf > 0 && crlf === 0
  return { lf, crlf, isLfOnly, bytes: buf.length }
}

/** Conversion au niveau OCTET : LF -> CRLF, en préservant tous les autres
 *  octets. Ne décode/re-encode jamais, donc aucun risque pour les accents
 *  (les .bat contiennent notamment « ARCHIVÉ »). */
function fix(file) {
  const buf = fs.readFileSync(file)
  const out = []
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) {
      out.push(0x0d, 0x0a)
      i++
    } else if (buf[i] === 0x0a) {
      out.push(0x0d, 0x0a)
    } else {
      out.push(buf[i])
    }
  }
  fs.writeFileSync(file, Buffer.from(out))
  return buf.length
}

function main() {
  const shouldFix = process.argv.includes('--fix')
  const files = collectBatchFiles(ROOT).sort()
  const broken = []

  for (const file of files) {
    const { lf, crlf, isLfOnly } = analyze(file)
    const rel = path.relative(ROOT, file)
    if (isLfOnly) broken.push({ rel, lf, file })
    else if (lf > 0) {
      console.log(`  OK    ${rel}  (LF=${lf} CRLF=${crlf})`)
    }
  }

  if (broken.length === 0) {
    console.log(`✅ [EOL] ${files.length} fichier(s) .bat/.cmd — tous en CRLF.`)
    return 0
  }

  console.error('')
  console.error('🚨 [EOL] Fichier(s) .bat/.cmd en LF-ONLY — INCOMPATIBLE cmd.exe :')
  console.error('')
  for (const b of broken) {
    console.error(`   ❌ ${b.rel}  (${b.lf} lignes LF, 0 CRLF)`)
  }
  console.error('')
  console.error('   cmd.exe lit un .bat LF-only comme UNE SEULE commande et la découpe')
  console.error('   sur les espaces / "(" / ")" : chaque ligne devient un fragment')
  console.error('   inexécutable. Les étapes du script ne tournent plus du tout.')

  if (!shouldFix) {
    console.error('')
    console.error('   Correctif : npm run fix:eol')
    return 1
  }

  console.error('')
  for (const b of broken) {
    const before = fs.statSync(b.file).size
    fix(b.file)
    const after = fs.statSync(b.file).size
    const check = analyze(b.file)
    const ok = !check.isLfOnly
    console.log(
      `   ${ok ? '✅' : '❌'} ${b.rel}  ${before} o -> ${after} o  (LF=${check.lf} CRLF=${check.crlf})`
    )
  }
  console.log('✅ [EOL] Conversion LF -> CRLF terminée.')
  // On revérifie : on ne déclare succès que si tout est réellement propre.
  const still = broken.filter((b) => analyze(b.file).isLfOnly)
  if (still.length > 0) {
    console.error(`❌ [EOL] ${still.length} fichier(s) toujours en LF-only après correction.`)
    return 1
  }
  return 0
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { analyze, collectBatchFiles }
