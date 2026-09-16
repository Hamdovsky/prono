const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const REPO = path.join(__dirname, '..')
const TACTICAL = path.join(REPO, 'data', 'tactical.db')
const LOG = path.join(REPO, 'logs', 'info.log')
const THRESHOLD = 700
const TAIL_BYTES = Number(process.env.CHECKPOINT_TAIL_BYTES || 8 * 1024 * 1024)
const WINDOW_MS = 24 * 60 * 60 * 1000

const TAG_RE = /\[CRON\] HT \+ Corners extraction|\[FOTMOB-STATS\]/
// Erreurs : on teste le MESSAGE (pas le timestamp, sinon .404Z/.403Z -> faux positifs).
// 404/403 exiges en contexte HTTP (status=404, 404 Not Found, err 403...) + mots d'erreur.
const HTTP_ERR_RE = /\b(404|403)\b(?=[^0-9]|$)(?=.*(http|status|not found|forbidden|error|echec|failed|fetch|request|api|scrape|blocked|banni|denied))/i
const ERR_WORD_RE = /\bexception\b|\berror\b|"level"\s*:\s*"error"|"level"\s*:\s*"warn".*\b(404|403)\b/i

function roiN() {
  const py = path.join(REPO, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3')
  const code = "import sys;sys.path.insert(0, r'" + REPO + "');from core.ou_roi_dataset import load_clean_ou_rows as f;print('N=' + str(len(f())))"
  for (const exe of [py, process.platform === 'win32' ? 'python' : 'python3']) {
    try {
      const r = spawnSync(exe, ['-c', code], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        timeout: 60000,
      })
      if (r.status === 0 && r.stdout) {
        const m = String(r.stdout).match(/N=(\d+)/)
        if (m) return Number(m[1])
      }
    } catch (_) { /* essai suivant */ }
  }
  return null
}

function counts() {
  if (!fs.existsSync(TACTICAL)) return { finished: null, homeXg: null, err: 'tactical.db absent' }
  const db = new Database(TACTICAL, { readonly: true, fileMustExist: true })
  try {
    return {
      finished: db.prepare("SELECT COUNT(*) c FROM matches WHERE status='finished'").get().c,
      homeXg: db.prepare('SELECT COUNT(*) c FROM matches WHERE home_xg IS NOT NULL').get().c,
      err: null,
    }
  } finally {
    db.close()
  }
}

function readTail(file, maxBytes) {
  if (!fs.existsSync(file)) return ''
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return text
  } finally {
    fs.closeSync(fd)
  }
}

function parseLine(line) {
  const ts = line.match(/"timestamp":"([^"]+)"/)
  const lvl = line.match(/"level":"([^"]+)"/)
  let msg = ''
  const mi = line.indexOf('"message":"')
  if (mi >= 0) {
    const rest = line.slice(mi + 11)
    const end = rest.indexOf('","')
    msg = end >= 0 ? rest.slice(0, end) : rest.replace(/"}\s*$/, '')
  }
  const t = ts ? Date.parse(ts[1]) : NaN
  return { ts: Number.isFinite(t) ? t : null, level: lvl ? lvl[1] : '', msg }
}

function isError(parsed) {
  if (parsed.level === 'ERROR') return true
  if (ERR_WORD_RE.test(parsed.msg)) return true
  if (HTTP_ERR_RE.test(parsed.msg)) return true
  return false
}

function main() {
  const n = roiN()
  const { finished, homeXg, err } = counts()
  const tail = readTail(LOG, TAIL_BYTES)
  const lines = tail.split(/\r?\n/).filter((l) => l.trim())

  const tagged = lines.filter((l) => TAG_RE.test(l)).slice(-20)

  const now = Date.now()
  const errors = []
  for (const l of lines) {
    const p = parseLine(l)
    if (p.ts == null || now - p.ts > WINDOW_MS) continue
    if (isError(p)) errors.push({ line: l, tagged: TAG_RE.test(l) })
  }
  const errShown = errors.slice(-30)

  console.log('=== E37 CHECKPOINT (lecture seule) ===')
  console.log('log     : ' + LOG + (fs.existsSync(LOG) ? '' : ' (ABSENT)'))
  console.log('tail    : ' + (TAIL_BYTES / (1024 * 1024)).toFixed(1) + ' Mo')
  console.log('')
  const nTxt = n == null ? 'INDISPONIBLE' : String(n)
  console.log('n (load_clean_ou_rows) : ' + nTxt + ' / ' + THRESHOLD)
  if (n != null && n >= THRESHOLD) console.log('  -> SEUIL ATTEINT : relancer --roi')
  else console.log('  -> attendre (pas de --roi)')
  console.log("matches.status='finished' : " + (finished == null ? 'INDISPONIBLE' : finished))
  console.log('matches.home_xg NOT NULL   : ' + (homeXg == null ? 'INDISPONIBLE' : homeXg))
  if (err) console.log('DB : ' + err)
  console.log('')

  console.log('--- 20 dernieres lignes [CRON] HT + Corners / [FOTMOB-STATS] ---')
  if (tagged.length === 0) console.log('(aucune ligne correspondante dans le tail)')
  else for (const l of tagged) console.log(l)
  console.log('')

  console.log('--- erreurs reelles (404/403 HTTP / Exception / level=ERROR) sur 24h ---')
  if (errShown.length === 0) console.log('aucune')
  else for (const e of errShown) console.log((e.tagged ? '>> ' : '   ') + e.line)
  console.log('')

  console.log(
    'RESUME: n=' + nTxt + '/' + THRESHOLD +
    ' | finished=' + (finished == null ? '?' : finished) +
    ' | home_xg=' + (homeXg == null ? '?' : homeXg) +
    ' | erreurs detectees: ' + (errShown.length ? 'oui (' + errShown.length + ')' : 'non')
  )
}

main()
