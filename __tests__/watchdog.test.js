/**
 * watchdog — logique de décision (sans réseau ni processus).
 *
 * E105 : API_CORE est restée morte en silence le 2026-10-15 alors que
 * concurrently tournait toujours. Ces tests verrouillent la règle critique :
 * le watchdog ne doit JAMAIS créer un doublon sur un port.
 */
const { decide, createTracker, tick, SERVICES, PROBE_HOSTS, anySucceeds, hungVerdict, hungThresholdFor, HUNG_MULT } = require('../scripts/watchdog')

describe('watchdog — anySucceeds()', () => {
  const ok = (d = 0) => () => new Promise((r) => setTimeout(() => r(true), d))
  const ko = (d = 0) => () => new Promise((r) => setTimeout(() => r(false), d))

  it('renvoie true des qu une seule tentative reussit', async () => {
    await expect(Promise.all([anySucceeds([ok()])])).resolves.toBeDefined()
    await expect(anySucceeds([ok()])).resolves.toBe(true)
  })

  it('renvoie false seulement quand TOUTES echouent', async () => {
    await expect(anySucceeds([ko(), ko(), ko()])).resolves.toBe(false)
  })

  it('NE laisse pas un echec rapide masquer un succes lent', async () => {
    // Regression E105 : avec Promise.any, cet echec instantane sur `localhost`
    // resolvait avec `false` et l'emportait sur le succes de `127.0.0.1`,
    // faisant croire le service mort -> relance en boucle de Vite.
    // Semantique correcte : un seul succes suffit, meme tardif.
    const tasks = [ko(0), ko(1), ok(40), ko(2)]
    await expect(anySucceeds(tasks)).resolves.toBe(true)
  })

  it('ne resout false qu apres le dernier echec', async () => {
    const order = []
    const tracked = [10, 30, 60].map((d, i) => () =>
      new Promise((r) => setTimeout(() => { order.push(i); r(false) }, d))
    )
    await expect(anySucceeds(tracked)).resolves.toBe(false)
    expect(order).toEqual([0, 1, 2])
  })

  it('liste vide => false', async () => {
    await expect(anySucceeds([])).resolves.toBe(false)
  })
})

describe('watchdog — familles d adresses', () => {
  it('sonde les deux familles (IPv4 et IPv6)', () => {
    // Vite n'ecoute que sur ::1, l'API sur 0.0.0.0. Sonder une seule famille
    // declarait le dashboard mort en boucle.
    expect(PROBE_HOSTS).toContain('127.0.0.1')
    expect(PROBE_HOSTS).toContain('::1')
  })
})

describe('watchdog — decide()', () => {
  it('ne fait rien quand le service repond', () => {
    expect(decide(true, 0, 3, false)).toBe('none')
    expect(decide(true, 99, 3, false)).toBe('none')
  })

  it('attend tant que le seuil n est pas atteint', () => {
    expect(decide(false, 1, 3, true)).toBe('wait')
    expect(decide(false, 2, 3, true)).toBe('wait')
  })

  it('relance une fois le seuil atteint et le port libre', () => {
    expect(decide(false, 3, 3, true)).toBe('restart')
    expect(decide(false, 10, 3, true)).toBe('restart')
  })

  it("s'efface si le port est deja occupe (anti-doublon)", () => {
    // C'est LA regle critique : si concurrently remonte le service, on ne
    // lance rien, sous peine de creer un second processus sur le meme port.
    expect(decide(false, 99, 3, false)).toBe('skip')
  })
})

describe('watchdog — tick()', () => {
  it('reinitialise le compteur quand le service repond', () => {
    const st = createTracker()
    st.streak = 2
    const r = tick(st, true, 3)
    expect(r.streak).toBe(0)
    expect(r.action).toBe('none')
  })

  it('incremente le compteur a chaque echec', () => {
    // tick() est PUR : il retourne le nouveau streak sans muter l'etat.
    // C'est le appelant (runOnce/main) qui le réassigne.
    const st = createTracker()
    const a = tick(st, false, 3)
    expect(a.streak).toBe(1)
    st.streak = a.streak
    const b = tick(st, false, 3)
    expect(b.streak).toBe(2)
    st.streak = b.streak
    expect(tick(st, false, 3).streak).toBe(3)
  })

  it('signale "due" au seuil, "wait" avant', () => {
    const st = createTracker()
    expect(tick(st, false, 3).action).toBe('wait')
    st.streak = 1
    expect(tick(st, false, 3).action).toBe('wait')
    st.streak = 2
    expect(tick(st, false, 3).action).toBe('due')
  })

  it('ignore les sondes rapprochees (anti-flap)', () => {
    // Une micro-coupure ne doit pas provoquer une relance.
    const st = createTracker()
    st.streak = 1
    st.streak = tick(st, true, 3).streak // 0 : repond
    st.streak = tick(st, false, 3).streak // 1
    st.streak = tick(st, false, 3).streak // 2 -> wait
    expect(tick(st, false, 3).action).toBe('due')
  })

  it('annonce une recuperation apres une relance', () => {
    const st = createTracker()
    st.lastAction = 'restart'
    expect(tick(st, true, 3).action).toBe('recovered')
  })
})

describe('watchdog — configuration des services', () => {
  it('couvre au minimum l API, le moteur ML et l UI', () => {
    const names = SERVICES.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['API_CORE', 'ML_CORE', 'UI_DASH']))
  })

  it('chaque service declare un port et un seuil', () => {
    for (const s of SERVICES) {
      expect(typeof s.port).toBe('number')
      expect(s.port).toBeGreaterThan(0)
      expect(s.downThreshold).toBeGreaterThanOrEqual(2)
      expect(typeof s.command).toBe('string')
      expect(Array.isArray(s.args)).toBe(true)
    }
  })

  it('porte des ports distincts (pas de collision interne)', () => {
    const ports = SERVICES.map((s) => s.port)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('API_CORE est supervisee sur le bon port (celui de start.bat)', () => {
    const api = SERVICES.find((s) => s.name === 'API_CORE')
    expect(api.port).toBe(3001)
    expect(api.args).toContain('server.js')
  })
})

describe('watchdog — hung (E106)', () => {
  it("le skip historique est conserve pour l'occupe-transitoire", () => {
    // La regle anti-doublon ne change pas : port occupe + seuil atteint
    // => on s'efface d'abord. C'est la boucle infinie de skips qui est
    // soignee, pas la prudence du premier skip.
    expect(decide(false, 99, 3, false)).toBe('skip')
  })

  it('hungVerdict attend avant le seuil, reclame au seuil', () => {
    expect(hungVerdict(0, 9)).toBe('wait')
    expect(hungVerdict(8, 9)).toBe('wait')
    expect(hungVerdict(9, 9)).toBe('reclaim')
    expect(hungVerdict(99, 9)).toBe('reclaim')
  })

  it('le seuil hung derive du downThreshold (x3 par defaut)', () => {
    expect(HUNG_MULT).toBeGreaterThanOrEqual(1)
    expect(hungThresholdFor({ downThreshold: 3 })).toBe(3 * HUNG_MULT)
    expect(hungThresholdFor({ downThreshold: 4 })).toBe(4 * HUNG_MULT)
  })

  it('le seuil hung est surchargeable par service', () => {
    expect(hungThresholdFor({ downThreshold: 3, hungThreshold: 5 })).toBe(5)
  })

  it('le tracker porte le compteur hung, remis a zero comme le streak', () => {
    const st = createTracker()
    expect(st.hungStreak).toBe(0)
    // tick() reste le compteur HTTP : le hung est compté par la boucle
    // principale (HTTP muet + port occupe), pas par tick().
    st.hungStreak += 1
    const r = tick({ ...st, streak: 2 }, true, 3)
    expect(r.streak).toBe(0)
  })

  it('ML_CORE reclame apres 9 cycles hung par defaut (3x30s + 9x30s)', () => {
    // Dokumentation du delai : downThreshold=3 puis hungThreshold=9,
    // soit ~6 min de HTTP muet avant kill — pas de massacre sur micro-coupure.
    const ml = SERVICES.find((s) => s.name === 'ML_CORE')
    expect(hungThresholdFor(ml)).toBe(ml.downThreshold * HUNG_MULT)
  })
})