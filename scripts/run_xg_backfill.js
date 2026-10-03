/**
 * run_xg_backfill.js — E73b : pilote le backfill xG jusqu'a epuisement.
 *
 *Pourquoi un pilote et pas une boucle shell : le backfill se arrete seul
 * (voir STOP_RULES) et journalise. Relancer a la main `backfill_xg_fotmob.js
 * --write --limit 300` sept fois en forgot d'attendre est le meilleur moyen de
 * tuer le job et de perdre le suivi.
 *
 * REGLES D'ARRET — le but est de ne pas bruler des heures de calls pour rien :
 *   - backlog vide                -> FIN, plus rien a faire
 *   - 4 lots consecutifs sans ecriture -> FIN
 *   - SIGINT/SIGTERM               -> arret propre, journal conserve
 *
 * MESURE AVERTISSANTE (E73b, echantillon aleatoire de 40 matchs du backlog) :
 * le taux de RESOLUTION date+equipes sur le flux FotMob du jour n'est que de
 * 27%, exactement la couverture deja atteinte. La limite n'est donc pas le
 * script : FotMob ne publie pas la majorite de ces matchs (Botswana vs
 * Mozambique, Alessandria vs Imperia, Workington vs Guiseley...), tres
 * probablement parce qu'ils relevent de divisions qu'il ne couvre pas. Le
 * backlog ne descendra pas a zero par ce canal ; chaque lot coutait ~2.5 s et
 * n'apporterait que ~1 ecriture sur 4. Le pilote s'arrete donc tot. Pour
 * couvrir ces matchs il faut une autre source (API-Football, deja
 * configuree, ou l'archive Neon).
 *
 * Chaque lot ecrit l'etat dans logs/xg_backfill.json : reprisable apres un
 * arret, et lisible sans.tail -f.
 *
 * Usage : node scripts/run_xg_backfill.js
 *         node scripts/run_xg_backfill.js --max-lots 3   (essai)
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const LOG_DIR = path.join(__dirname, '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'xg_backfill.json')
const MAX_LOTS = Number(
  (process.argv.indexOf('--max-lots') > -1 && process.argv[process.argv.indexOf('--max-lots') + 1]) || 40
)
const LIMIT = Number(process.env.XG_BATCH || 250)
// --force : le pilote ne s'arrete pas sur rendement faible (useful quand on sait
// que le lot vise des matchs couverts).
const hasFlagForce = () => process.argv.includes('--force')

const DRY_STREAK_STOP = 4

fs.mkdirSync(LOG_DIR, { recursive: true })

function saveState(state) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(state, null, 2))
}

function logLine(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] ${msg}`)
}

function runLot() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, 'backfill_xg_fotmob.js'), '--write', '--limit', String(LIMIT)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    const collect = (buf) => {
      const s = buf.toString()
      if (!/[DB]|DATABASE|MIGRATION|leagues_config|validated/.test(s)) out += s
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('close', () => {
      const num = (re) => {
        const m = out.match(re)
        return m ? Number(m[1]) : null
      }
      resolve({
        scanned: num(/scanned\s*:\s*(\d+)/),
        matched: num(/matched\s*:\s*(\d+)/),
        written: num(/written\s*:\s*(\d+)/),
        before: num(/backlog avant\s*:\s*(\d+)/),
        after: num(/backlog\s*:\s*(\d+)\s*->\s*(\d+)/),
        raw: out.trim()
      })
    })
    child.on('error', (e) => resolve({ error: e.message }))
  })
}

let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) process.exit(1)
    stopping = true
    logLine(`arret demande (${sig}) — journal conserve, relancer pour reprendre`)
    process.exit(0)
  })
}

async function main() {
  let state
  try {
    state = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
    logLine(`reprise : ${state.lotsDone} lots deja faits, backlog ${state.backlogAfter ?? '?'}`)
  } catch {
    state = { startedAt: new Date().toISOString(), lotsDone: 0, totalWritten: 0, emptyStreak: 0 }
  }

  logLine(`lot = ${LIMIT} matchs, max ${MAX_LOTS} lots`)
  saveState(state)

  for (let i = 0; i < MAX_LOTS && !stopping; i++) {
    const t0 = Date.now()
    const r = await runLot()
    if (r.error) {
      logLine(`ERREUR lot ${i + 1} : ${r.error}`)
      state.error = r.error
      saveState(state)
      break
    }

    const done = (r.before ?? 0) - (r.after ?? 0)
    state.lotsDone += 1
    state.totalWritten += r.written ?? 0
    state.backlogAfter = r.after
    state.lastLotAt = new Date().toISOString()

    if ((r.written ?? 0) === 0) state.emptyStreak += 1
    else state.emptyStreak = 0

    const rate = r.written ? ((done ?? 0) / ((Date.now() - t0) / 1000)).toFixed(2) : '0'
    logLine(
      `lot ${i + 1}/${MAX_LOTS} : ${r.written ?? 0} ecrit(s), backlog ${r.before} -> ${r.after}` +
        ` [${((Date.now() - t0) / 1000).toFixed(0)}s, ${rate} m/s]`
    )
    saveState(state)

    if ((r.after ?? 1) <= 0) {
      logLine('backlog epuise -> FIN')
      state.reason = 'backlog_epuise'
      break
    }
    if (state.emptyStreak >= DRY_STREAK_STOP) {
      logLine(`${DRY_STREAK_STOP} lots consecutifs sans ecriture -> FIN (backlog non couvert)`)
      state.reason = 'rendement_nul'
      break
    }
    // Rendement faible : c'est le regime normal mesure (27% de resolution).
    // On ne laisse pas le pilote epuiser des heures pour une progression
    // marginale ; --max-lots reste le levier pour aller plus loin.
    const yield2 = ((r.written ?? 0) / (r.scanned || 1)) * 100
    if (state.lotsDone >= 2 && yield2 < 20 && !hasFlagForce()) {
      logLine(`rendement ${yield2.toFixed(0)}% sur ${state.lotsDone} lots -> arret`)
      state.reason = 'rendement_faible'
      break
    }
  }

  if (!state.reason) state.reason = state.lotsDone >= MAX_LOTS ? 'max_lots_atteint' : 'interrompu'

  console.log('')
  console.log('  resume')
  console.log('  ------')
  console.log(`  lots executes    : ${state.lotsDone}`)
  console.log(`  lignes ecrites   : ${state.totalWritten}`)
  console.log(`  backlog restant  : ${state.backlogAfter ?? '?'}`)
  console.log(`  raison d'arret   : ${state.reason}`)
  console.log(`  journal          : ${path.relative(process.cwd(), LOG_FILE)}`)
  console.log('')
  saveState(state)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})