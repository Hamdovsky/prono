/**
 * watchdog.js — supervision externe des services Titanium.
 *
 * POURQUOI (E105) : le 2026-10-15, API_CORE (node server.js, port 3001) s'est
 * arrêté. `concurrently` tourne toujours avec `--restart-tries 10` mais ne l'a
 * PAS relancé — les autres services (Vite, Streamlit, PixelRAG) ayant eux
 * redémarré à la même seconde. Résultat : l'API est restée morte, silencieusement,
 * et personne ne l'a noticed avant un diagnostic manuel.
 *
 * Un serveur mort ne peut pas se surveiller lui-même : il faut un tiers.
 *
 * PRINCIPE ANTI-DOUBLON (même logique que le remède AUTOHEAL E103) :
 *   1. on ne fait RIEN tant que le port répond ;
 *   2. il faut `downThreshold` sondes consécutives en échec, pour ne pas agir
 *      pendant un redémarrage normal ;
 *   3. on vérifie que le port est réellement LIBRE avant de relancer — si
 *      concurrently est en train de le remonter, on s'efface.
 * On ne peut donc jamais créer deuxBbb processus sur le même port.
 *
 * Usage : node scripts/watchdog.js [--interval=30000] [--dry-run]
 */
const http = require('http')
const net = require('net')
const { spawn, exec } = require('child_process')
const path = require('path')
const logger = require('../core/logger')

const ROOT = path.resolve(__dirname, '..')

// E106 : le watchdog detectait le hung (HTTP muet) mais ne le soignait jamais.
// `decide(..., portFree=false)` => 'skip' + reset du streak => boucle infinie
// de skips tant que le port reste occupe (constate en dry-run : ML_CORE
// injoignable sondes 3, 4, 5, toujours skippe). Pire : le probe TCP reussit en
// pointilles sur un uvicorn hung (CLOSE_WAIT), donc un cycle peut voir le port
// "libre" et spawner un doublon — exactement le defaut E103.
// Correctif : compteur `hungStreak` (HTTP DOWN + port occupe). Au-dela de
// `hungThreshold`, on tue l'arbre qui squatte le port (killTree, comme le
// remede AUTOHEAL E103) puis on verifie le port libre AVANT de respawner.
// Jamais de doublon : pas de spawn sans port libre verifie.
const _hungMult = parseInt(process.env.WATCHDOG_HUNG_MULT, 10)
const HUNG_MULT = Number.isNaN(_hungMult) ? 3 : _hungMult
function hungThresholdFor(svc) {
  return svc.hungThreshold || svc.downThreshold * HUNG_MULT
}

/** Définition des services supervisés. */
const SERVICES = [
  {
    name: 'API_CORE',
    port: 3001,
    probe: { path: '/api/health' },
    // Relance par le superviseur : on réutilise la commande exacte de start.bat
    command: process.execPath,
    args: ['--max-old-space-size=512', 'server.js'],
    cwd: ROOT,
    downThreshold: 3,
  },
  {
    name: 'ML_CORE',
    port: 8000,
    probe: { path: '/health' },
    command: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    args: ['-m', 'uvicorn', 'core.fastapi_server:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1'],
    cwd: ROOT,
    downThreshold: 3,
  },
  {
    name: 'UI_DASH',
    port: 5173,
    probe: { path: '/' },
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['vite'],
    cwd: ROOT,
    downThreshold: 4,
  },
]

// ── Sondes ───────────────────────────────────────────────────────────────────

/**
 * Hôtes sondés, dans cet ordre.
 *
 * E105 : Vite (UI_DASH) n'écoute que sur `::1` — le serveur de dev Vite se lie
 * par défaut sur le localhost IPv6 — tandis que l'API écoute sur `0.0.0.0`.
 * Sonder uniquement `127.0.0.1` faisait conclure a tort que le dashboard etait
 * mort, et le watchdog l'aurait relance en boucle indefiniment. On teste donc
 * les deux familles : un service est vivant des qu'une seule repond.
 */
const PROBE_HOSTS = ['127.0.0.1', '::1', 'localhost']

/**
 * Agrège des tentatives并发 : vrai dès qu'une seule aboutit, faux seulement
 * quand TOUTES ont échoué.
 *
 * On n'utilise volontairement pas `Promise.any` : celle-ci retourne la
 * première promesse *résolue*, donc un echec rapide (sur `localhost`) l'emporte
 * sur un succes lent (sur `127.0.0.1`) et le service parait mort alors qu'il
 * répond. Ici, `false` n'est resolu qu'en dernier recours.
 */
function anySucceeds(tasks) {
  return new Promise((resolve) => {
    let pending = tasks.length
    if (pending === 0) return resolve(false)
    tasks.forEach((task) =>
      task().then((ok) => {
        if (ok) return resolve(true)
        if (--pending === 0) resolve(false)
      })
    )
  })
}

/** Le port accepte-t-il une connexion TCP sur l'un des hôtes ? */
function probePort(port, timeoutMs = 2500, hosts = PROBE_HOSTS) {
  return anySucceeds(
    hosts.map(
      (host) => () =>
        new Promise((resolve) => {
          const socket = new net.Socket()
          let settled = false
          const done = (v) => {
            if (settled) return
            settled = true
            socket.destroy()
            resolve(v)
          }
          socket.setTimeout(timeoutMs)
          socket.once('connect', () => done(true))
          socket.once('timeout', () => done(false))
          socket.once('error', () => done(false))
          socket.connect(port, host)
        })
    )
  )
}

/**
 * Sonde HTTP : on privilégie le code de retour, on retombe sur le port.
 * `>= 500` compte comme « répond mais en défaut » : on ne relance pas un service
 * qui est vivant, seulement un service muet.
 */
function probeHttp(port, httpPath, timeoutMs = 4000, hosts = PROBE_HOSTS) {
  return anySucceeds(
    hosts.map(
      (host) => () =>
        new Promise((resolve) => {
          let settled = false
          const done = (v) => {
            if (settled) return
            settled = true
            resolve(v)
          }
          const req = http.get(
            { hostname: host, port, path: httpPath, timeout: timeoutMs },
            (res) => {
              res.resume()
              done(res.statusCode < 500)
            }
          )
          req.on('error', () => done(false))
          req.on('timeout', () => {
            req.destroy()
            done(false)
          })
        })
    )
  )
}

// ── Reclaim d'un port squatte (E106) ─────────────────────────────────────────
// Miroir des helpers AUTOHEAL (services/autoHealRemedies.js:29-76) : le
// watchdog reste autonome (pas de require lourd), mais meme semantique —
// tuer l'ARBRE (le shim .venv cree un enfant Python312 qui survit sinon).
const EXEC_TIMEOUT_MS = 5000
function execSafe(cmd) {
  return new Promise((resolve) => {
    let done = false
    const finish = (out) => {
      if (done) return
      done = true
      resolve(out)
    }
    const t = setTimeout(() => finish(''), EXEC_TIMEOUT_MS)
    exec(cmd, { windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      clearTimeout(t)
      finish(stdout || '')
    })
  })
}

function pidsOnPort(port) {
  if (process.platform !== 'win32') {
    return execSafe(`lsof -ti tcp:${port} 2>/dev/null`).then((o) =>
      o.trim() ? o.trim().split(/\s+/).map((p) => parseInt(p, 10)).filter((p) => !isNaN(p) && p > 0) : []
    )
  }
  return execSafe(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`).then((stdout) => {
    if (!stdout.trim()) return []
    const pids = new Set()
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[parts.length - 1], 10)
      if (!isNaN(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  })
}

function killTree(pid) {
  if (process.platform !== 'win32') return execSafe(`kill -9 ${pid}`)
  return execSafe(`taskkill /f /t /pid ${pid}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Tue les PIDs a l'ecoute (avec leur arbre) puis verifie que le port est
// vraiment libre. true = libere. Ne spawne jamais sur un port encore occupe.
async function freePort(port, maxRounds = 5) {
  for (let round = 1; round <= maxRounds; round++) {
    const pids = await pidsOnPort(port)
    if (pids.length === 0) return true
    for (const pid of pids) {
      logger.warn(`[WATCHDOG] Liberation du port ${port} — kill PID ${pid} (arbre)`)
      await killTree(pid)
    }
    await sleep(1200)
    if ((await pidsOnPort(port)).length === 0) return true
  }
  return (await pidsOnPort(port)).length === 0
}

// ── Cœur injectable (testable sans réseau ni processus) ──────────────────────

/**
 * Décide de l'action à mener pour un service.
 * @param {boolean} alive      la sonde a réussi
 * @param {number}  streak     nombre d'échecs consécutifs
 * @param {number}  threshold  seuil avant action
 * @param {boolean} portFree   le port est-il réellement libre ?
 * @returns {'none'|'wait'|'restart'|'skip'}
 */
function decide(alive, streak, threshold, portFree) {
  if (alive) return 'none'
  if (streak < threshold) return 'wait'
  // Le port est déjà pris : quelqu'un d'autre (concurrently, AUTOHEAL) remonte
  // le service. On s'efface pour ne jamais créer de doublon.
  if (!portFree) return 'skip'
  return 'restart'
}

function createTracker() {
  return { streak: 0, hungStreak: 0, lastAction: null }
}

/**
 * E106 : le port est occupe mais le HTTP reste muet (hung). 'wait' tant que
 * le seuil hung n'est pas atteint, 'reclaim' au-dela : tuer l'arbre qui
 * squatte puis respawner (port libre verifie, jamais de doublon).
 * Pure : aucun IO.
 */
function hungVerdict(hungStreak, hungThreshold) {
  if (hungStreak >= hungThreshold) return 'reclaim'
  return 'wait'
}

/**
 * Met à jour l'état d'un service. Pure : aucun IO.
 * @returns {{action:string, streak:number}}
 */
function tick(state, alive, threshold) {
  if (alive) {
    return { action: state.lastAction === 'restart' ? 'recovered' : 'none', streak: 0 }
  }
  const streak = state.streak + 1
  return { action: streak < threshold ? 'wait' : 'due', streak }
}

module.exports = {
  SERVICES,
  probePort,
  probeHttp,
  decide,
  createTracker,
  tick,
  hungVerdict,
  hungThresholdFor,
  HUNG_MULT,
  pidsOnPort,
  killTree,
  freePort,
  anySucceeds,
  ROOT,
  PROBE_HOSTS,
}

// ── Exécution ────────────────────────────────────────────────────────────────

// PAS de `detached` ni de `unref` : les services relances doivent rester
// dans l'arbre de processus du watchdog, sinon ils survivent a un
// `stop_local_services` et on rebatit les piles en double — exactement
// le defaut AUTOHEAL corrige en E103 (deux FastAPI / deux PixelRAG).
// Consequence : pas d'appel a child.unref(), sinon le watchdog ne
// pourrait pas sortir sur SIGINT ; la sortie est explicite plus bas.
function spawnService(svc) {
  const child = spawn(svc.command, svc.args, {
    cwd: svc.cwd,
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32' && svc.command.endsWith('.cmd'),
  })
  child.on('error', (e) => logger.error(`[WATCHDOG] ${svc.name} spawn error: ${e.message}`))
  return child
}

async function runOnce(services, dryRun) {
  const results = []
  for (const svc of services) {
    const alive = svc.probe
      ? await probeHttp(svc.port, svc.probe.path)
      : await probePort(svc.port)
    results.push({ svc, alive })
  }
  return results
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const intervalArg = argv.find((a) => a.startsWith('--interval='))
  const interval = intervalArg ? parseInt(intervalArg.split('=')[1], 10) : 30000

  const trackers = new Map()
  for (const svc of SERVICES) trackers.set(svc.name, createTracker())

  logger.info(`👁️  [WATCHDOG] ${SERVICES.length} service(s) supervisés, intervalle ${interval} ms${dryRun ? ' (DRY-RUN)' : ''}`)
  logger.info(`👁️  [WATCHDOG] ${SERVICES.map((s) => `${s.name}:${s.port}`).join('  ')}`)

  const tickOnce = async () => {
    const results = await runOnce(SERVICES, dryRun)
    for (const { svc, alive } of results) {
      const st = trackers.get(svc.name)
      const { action, streak } = tick(st, alive, svc.downThreshold)

      if (alive) {
        if (action === 'recovered') {
          logger.info(`✅ [WATCHDOG] ${svc.name} (${svc.port}) répond de nouveau.`)
          st.lastAction = null
        }
        st.streak = 0
        st.hungStreak = 0
        continue
      }

      st.streak = streak
      if (action === 'wait') {
        logger.debug(`[WATCHDOG] ${svc.name} (${svc.port}) injoignable (${streak}/${svc.downThreshold})`)
        continue
      }

      // Seuil atteint : vérifier que le port est libre avant toute action.
      const portFree = !(await probePort(svc.port, 1500))
      const verdict = decide(false, streak, svc.downThreshold, portFree)

      if (verdict === 'skip') {
        // E106 : le port est occupe mais le HTTP est muet — ce n'est pas
        // forcement concurrently qui remonte (processus hung, comme ML_CORE
        // PID 21120 : LISTENING mais /health en timeout, CLOSE_WAIT en pile).
        // On ne reset PLUS le streak (l'ancien reset + skip = boucle infinie
        // sans jamais soigner). Au-dela de hungThreshold : reclaim.
        st.hungStreak = (st.hungStreak || 0) + 1
        const hungThreshold = hungThresholdFor(svc)
        if (hungVerdict(st.hungStreak, hungThreshold) !== 'reclaim') {
          logger.info(
            `⏭  [WATCHDOG] ${svc.name} (${svc.port}) : port occupé mais HTTP muet (hung ${st.hungStreak}/${hungThreshold}) — un autre superviseur s'en charge peut-être, on attend.`
          )
          continue
        }
        logger.error(
          `🚨 [WATCHDOG] ${svc.name} (${svc.port}) : HTTP muet depuis ${st.hungStreak} cycles alors que le port est occupé — processus hung, reclaim (kill arbre + respawn).`
        )
        if (dryRun) continue
        try {
          const freed = await freePort(svc.port)
          if (!freed) {
            logger.error(`[WATCHDOG] ${svc.name} reclaim impossible: port ${svc.port} toujours occupé après kill — pas de doublon, on réessaiera.`)
            continue
          }
          spawnService(svc)
          st.lastAction = 'restart'
          st.streak = 0
          st.hungStreak = 0
        } catch (e) {
          logger.error(`[WATCHDOG] ${svc.name} reclaim impossible: ${e.message}`)
        }
        continue
      }

      logger.error(
        `🚨 [WATCHDOG] ${svc.name} (${svc.port}) injoignable depuis ${streak} sondes — relance.`
      )
      if (dryRun) continue
      try {
        spawnService(svc)
        st.lastAction = 'restart'
      } catch (e) {
        logger.error(`[WATCHDOG] ${svc.name} relance impossible: ${e.message}`)
      }
    }
  }

  await tickOnce()
  const timer = setInterval(tickOnce, interval)
  process.on('SIGINT', () => {
    logger.info('[WATCHDOG] Arrêt demandé.')
    clearInterval(timer)
    process.exit(0)
  })
}

if (require.main === module) {
  main().catch((e) => {
    logger.error(`[WATCHDOG] Erreur fatale: ${e.message}`)
    process.exit(1)
  })
}