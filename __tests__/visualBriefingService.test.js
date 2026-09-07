/**
 * visualBriefingService — lecteur RAG vision (OpenAI-compatible, défaut OpenRouter).
 * Aucun réseau : axios mocké. Le setup.js global mocke fs (existsSync ne voit
 * que les chemins contenant 'data', readFileSync -> '{}') -> tuiles et fichier
 * de budget placés sous un chemin 'data', budget piloté via mockImplementation.
 */
const path = require('path')
const os = require('os')

jest.mock('axios')
const axios = require('axios')
const fsMock = require('fs')

const usageFile = path.join(os.tmpdir(), 'data', `vb_usage_${process.pid}.json`)
process.env.VISUAL_BRIEFING_USAGE_FILE = usageFile
process.env.VISUAL_BRIEFING_MAX_MONTHLY = '2'

const briefing = require('../services/visualBriefingService')

function fakeTilePath(name) {
  // 'data' dans le chemin -> existsSync (mock global) renvoie true
  return path.join(os.tmpdir(), 'data', name)
}

const month = () => new Date().toISOString().substring(0, 7)

function httpError(status) {
  const e = new Error(`HTTP ${status}`)
  e.response = { status }
  return e
}

describe('visualBriefingService', () => {
  const saved = {
    key: process.env.VISION_LLM_API_KEY,
    or: process.env.OPENROUTER_API_KEY,
    groq: process.env.GROQ_API_KEY,
    flag: process.env.VISUAL_BRIEFING,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.VISION_LLM_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.GROQ_API_KEY
    delete process.env.VISUAL_BRIEFING
    fsMock.readFileSync.mockImplementation(() => '{}')
  })

  afterAll(() => {
    process.env.VISION_LLM_API_KEY = saved.key
    process.env.OPENROUTER_API_KEY = saved.or
    process.env.GROQ_API_KEY = saved.groq
    process.env.VISUAL_BRIEFING = saved.flag
  })

  test('enabled() faux sans aucune clé', () => {
    expect(briefing.enabled()).toBe(false)
  })

  test('enabled() vrai via OPENROUTER_API_KEY (fallback)', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(briefing.enabled()).toBe(true)
  })

  test('enabled() VISION_LLM_API_KEY prioritaire', () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    expect(briefing.enabled()).toBe(true)
  })

  test('enabled() faux si VISUAL_BRIEFING=off même avec clé', () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    process.env.VISUAL_BRIEFING = 'off'
    expect(briefing.enabled()).toBe(false)
  })

  test('generateBriefing retourne null sans clé (pas d’appel HTTP)', async () => {
    const ctx = { tiles: [{ path: fakeTilePath('t1.png'), source: 'wikipedia' }] }
    const res = await briefing.generateBriefing({ homeTeam: 'A', awayTeam: 'B' }, ctx)
    expect(res).toBeNull()
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('generateBriefing retourne null sans tuile', async () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    const res = await briefing.generateBriefing({ homeTeam: 'A', awayTeam: 'B' }, { tiles: [] })
    expect(res).toBeNull()
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('generateBriefing appelle OpenRouter (text+image_url) et retourne le texte', async () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    axios.post.mockResolvedValueOnce({
      data: { choices: [{ message: { content: '• Forme solide\n• Effectif au complet\n• Historique favorable' } }] },
    })
    const ctx = { tiles: [{ path: fakeTilePath('t2.png'), source: 'wikipedia' }] }
    const res = await briefing.generateBriefing({ homeTeam: 'A', awayTeam: 'B' }, ctx)
    expect(res).toContain('Forme solide')
    expect(axios.post).toHaveBeenCalledTimes(1)
    const [url, body] = axios.post.mock.calls[0]
    expect(url).toContain('openrouter.ai')
    expect(body.model).toContain('minimax')
    expect(body.messages[0].content[0].type).toBe('text')
    expect(body.messages[0].content[1].type).toBe('image_url')
  })

  test('429 primaire -> retry automatique sur le modèle fallback', async () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    axios.post
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'briefing fallback' } }] } })
    const ctx = { tiles: [{ path: fakeTilePath('t5.png'), source: 'wikipedia' }] }
    const res = await briefing.generateBriefing({ homeTeam: 'A', awayTeam: 'B' }, ctx)
    expect(res).toBe('briefing fallback')
    expect(axios.post).toHaveBeenCalledTimes(2)
    expect(axios.post.mock.calls[1][1].model).toContain('gemma')
  })

  test('erreur non-429 -> null sans retry', async () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    axios.post.mockRejectedValueOnce(httpError(500))
    const ctx = { tiles: [{ path: fakeTilePath('t6.png'), source: 'wikipedia' }] }
    const res = await briefing.generateBriefing({ homeTeam: 'A', awayTeam: 'B' }, ctx)
    expect(res).toBeNull()
    expect(axios.post).toHaveBeenCalledTimes(1)
  })

  test('budget mensuel : stoppe au-delà de MAX_MONTHLY (sans HTTP)', async () => {
    process.env.VISION_LLM_API_KEY = 'sk-vision'
    axios.post.mockResolvedValue({ data: { choices: [{ message: { content: 'ok' } }] } })
    let count = 0
    fsMock.readFileSync.mockImplementation((p) => {
      if (String(p).includes('vb_usage')) {
        return JSON.stringify({ current_month: month(), count })
      }
      return '{}'
    })
    fsMock.writeFileSync.mockImplementation(() => {
      count += 1
    })
    const ctx = { tiles: [{ path: fakeTilePath('t3.png'), source: 'wikipedia' }] }
    const m = { homeTeam: 'A', awayTeam: 'B' }
    expect(await briefing.generateBriefing(m, ctx)).toBe('ok')
    expect(await briefing.generateBriefing(m, ctx)).toBe('ok')
    expect(await briefing.generateBriefing(m, ctx)).toBeNull()
    expect(axios.post).toHaveBeenCalledTimes(2)
  })
})
