/**
 * freeProxyPool.test.js — Tests unitaires du pool de proxys libres.
 * Tous les tests sont offline : les fonctions réseau sont contournées
 * via les hooks _internal (pool injecté, état contrôlé).
 */

const { EventEmitter } = require('events')

jest.mock('net', () => ({ connect: jest.fn() }))
jest.mock('tls', () => ({ connect: jest.fn() }))

const net = require('net')
const tls = require('tls')
const pool = require('../services/scrapers/freeProxyPool')

const internal = pool._internal

function resetState(list = []) {
  pool.reset()
  internal.__setEnabled(true)
  internal.__setPool(list)
}

describe('parseProxyList', () => {
  test('extrait les lignes host:port', () => {
    expect(pool.parseProxyList('1.2.3.4:8080\n5.6.7.8:3128\n')).toEqual(['1.2.3.4:8080', '5.6.7.8:3128'])
  })

  test('supprime le protocole et les credentials', () => {
    const text = 'http://1.2.3.4:8080\nsocks5://5.6.7.8:1080\nuser:pass@9.9.9.9:3128\n'
    expect(pool.parseProxyList(text)).toEqual(['1.2.3.4:8080', '5.6.7.8:1080', '9.9.9.9:3128'])
  })

  test('ignore commentaires, ports invalides et doublons', () => {
    const text = '# commentaire\n1.2.3.4:99999\n1.2.3.4:8080\n1.2.3.4:8080\n1.2.3.4:abc\n'
    expect(pool.parseProxyList(text)).toEqual(['1.2.3.4:8080'])
  })
})

describe('isAllowedUrl', () => {
  test('accepte un domaine de cotes en allowlist (HTTPS)', () => {
    expect(pool.isAllowedUrl('https://www.betexplorer.com/soccer/england/premier-league/')).toBe(true)
  })

  test('rejette le HTTP, les domaines hors allowlist et les URLs sensibles', () => {
    expect(pool.isAllowedUrl('http://www.betexplorer.com/x')).toBe(false)
    expect(pool.isAllowedUrl('https://evil.example.com/x')).toBe(false)
    expect(pool.isAllowedUrl('https://www.betexplorer.com/?api_key=123')).toBe(false)
    expect(pool.isAllowedUrl('https://www.betexplorer.com/?token=abc')).toBe(false)
  })

  test('rejette les entrées invalides', () => {
    expect(pool.isAllowedUrl('')).toBe(false)
    expect(pool.isAllowedUrl('pas une url')).toBe(false)
    expect(pool.isAllowedUrl(null)).toBe(false)
  })
})

describe('rotation & banlist', () => {
  test('round-robin sur le pool', () => {
    resetState(['a:1', 'b:2', 'c:3'])
    const g1 = pool.getProxy()
    const g2 = pool.getProxy()
    const g3 = pool.getProxy()
    const g4 = pool.getProxy()
    expect(new Set([g1, g2, g3])).toEqual(new Set(['a:1', 'b:2', 'c:3']))
    expect(g4).toBe(g1)
  })

  test('markBad exclut un proxy de la rotation', () => {
    resetState(['a:1', 'b:2', 'c:3'])
    pool.markBad('b:2')
    pool.markBad('c:3')
    expect(pool.getProxy()).toBe('a:1')
    expect(pool.getProxy()).toBe('a:1')
  })

  test('getProxyUrl ajoute le schéma http://', () => {
    expect(pool.getProxyUrl('1.2.3.4:8080')).toBe('http://1.2.3.4:8080')
    expect(pool.getProxyUrl(null)).toBe(null)
  })
})

describe('qualité & auto-dégradation', () => {
  test('pas de qualité tant que < 5 essais', () => {
    resetState()
    pool.recordAttempt(true)
    pool.recordAttempt(false)
    expect(pool.getQuality()).toBe(null)
  })

  test('taux de succès calculé sur la fenêtre', () => {
    resetState()
    for (let i = 0; i < 5; i++) pool.recordAttempt(true)
    expect(pool.getQuality()).toBe(1)
    for (let i = 0; i < 10; i++) pool.recordAttempt(false)
    expect(pool.getQuality()).toBe(5 / 15)
    expect(pool.isDegraded()).toBe(false)
  })

  test('dégradation quand le taux passe sous 25 %', () => {
    resetState()
    for (let i = 0; i < 5; i++) pool.recordAttempt(true)
    for (let i = 0; i < 35; i++) pool.recordAttempt(false)
    expect(pool.getQuality()).toBe(5 / 40)
    expect(pool.isDegraded()).toBe(true)
  })
})

describe('fetchText (sans réseau)', () => {
  test('retourne null si désactivé', async () => {
    pool.reset()
    internal.__setEnabled(false)
    internal.__setPool(['1.2.3.4:8080'])
    expect(await pool.fetchText('https://www.betexplorer.com/x')).toBe(null)
  })

  test('retourne null si le pool est vide', async () => {
    resetState([])
    expect(await pool.fetchText('https://www.betexplorer.com/x')).toBe(null)
  })

  test('retourne null si l’URL n’est pas autorisée', async () => {
    resetState(['1.2.3.4:8080'])
    expect(await pool.fetchText('https://evil.example.com/x')).toBe(null)
    expect(await pool.fetchText('http://www.betexplorer.com/x')).toBe(null)
  })
})

function makeFakeSocks() {
  const netSock = new EventEmitter()
  netSock.write = jest.fn()
  netSock.destroy = jest.fn()
  const tlsSock = new EventEmitter()
  tlsSock.write = jest.fn()
  tlsSock.destroy = jest.fn()
  tlsSock.setTimeout = jest.fn()
  net.connect = jest.fn(() => netSock)
  tls.connect = jest.fn(() => tlsSock)
  return { netSock, tlsSock }
}

describe('fetchTextThroughProxy — watchdog réponse (proxy muet)', () => {
  const flush = () => new Promise((r) => setImmediate(r))

  test('un proxy bavard au CONNECT mais muet en réponse rejette au lieu de hang', async () => {
    const { netSock, tlsSock } = makeFakeSocks()
    const p = pool.fetchTextThroughProxy('https://www.betexplorer.com/x', '1.2.3.4:8080', 5000)
    netSock.emit('connect')
    netSock.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await flush()
    tlsSock.emit('secureConnect')
    expect(tlsSock.setTimeout).toHaveBeenCalledWith(5000)
    tlsSock.emit('timeout')
    await expect(p).rejects.toThrow('proxy_response_timeout')
    expect(tlsSock.destroy).toHaveBeenCalled()
  })

  test('répond 200 + close -> resolve normal (pas de faux positif du watchdog)', async () => {
    const { netSock, tlsSock } = makeFakeSocks()
    const p = pool.fetchTextThroughProxy('https://www.betexplorer.com/x', '1.2.3.4:8080', 5000)
    netSock.emit('connect')
    netSock.emit('data', Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))
    await flush()
    tlsSock.emit('secureConnect')
    tlsSock.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"ok":1}'))
    tlsSock.emit('close')
    await expect(p).resolves.toMatchObject({ status: 200, body: '{"ok":1}' })
  })

  test('timeout au CONNECT (proxy mort) rejette toujours proxy_connect_timeout', async () => {
    const { netSock } = makeFakeSocks()
    const p = pool.fetchTextThroughProxy('https://www.betexplorer.com/x', '1.2.3.4:8080', 5000)
    netSock.emit('connect')
    netSock.emit('error', new Error('ECONNREFUSED'))
    await expect(p).rejects.toThrow('ECONNREFUSED')
  })
})
