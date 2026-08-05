const express = require('express')
const request = require('supertest')

jest.mock('../services/comboService', () => ({
  getTodayCombos: jest.fn(),
  refreshCombos: jest.fn(),
  loadHistory: jest.fn(),
}))

const comboService = require('../services/comboService')
const combosRouter = require('../routes/combos')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/combos', combosRouter)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('Combos Routes', () => {
  describe('GET /api/combos', () => {
    it('returns today combos as flat array', async () => {
      const mockCombos = [
        { id: 1, homeTeam: 'Arsenal', awayTeam: 'Chelsea', prediction: '1' },
        { id: 2, homeTeam: 'Barcelona', awayTeam: 'Real Madrid', prediction: 'X' },
      ]
      jest.spyOn(comboService, 'getTodayCombos').mockResolvedValue(mockCombos)

      const res = await request(app).get('/api/combos')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body.length).toBe(2)
      expect(res.body[0]).toHaveProperty('homeTeam')
    })

    it('returns empty array when no combos', async () => {
      jest.spyOn(comboService, 'getTodayCombos').mockResolvedValue([])
      const res = await request(app).get('/api/combos')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns 500 on error', async () => {
      jest.spyOn(comboService, 'getTodayCombos').mockRejectedValue(new Error('DB error'))
      const res = await request(app).get('/api/combos')
      expect(res.status).toBe(500)
      expect(res.body).toHaveProperty('error')
    })
  })

  describe('GET /api/combos/today', () => {
    it('returns { date, combos } wrapper', async () => {
      const mockCombos = [{ id: 1, homeTeam: 'Arsenal', awayTeam: 'Chelsea' }]
      jest.spyOn(comboService, 'getTodayCombos').mockResolvedValue(mockCombos)

      const res = await request(app).get('/api/combos/today')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('date')
      expect(res.body).toHaveProperty('combos')
      expect(Array.isArray(res.body.combos)).toBe(true)
      expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  })

  describe('POST /api/combos/generate', () => {
    it('triggers generation and returns success', async () => {
      const newCombos = [{ id: 1 }, { id: 2 }, { id: 3 }]
      jest.spyOn(comboService, 'refreshCombos').mockResolvedValue(newCombos)

      const res = await request(app).post('/api/combos/generate')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.generatedCount).toBe(3)
    })

    it('returns 500 on generation error', async () => {
      jest.spyOn(comboService, 'refreshCombos').mockRejectedValue(new Error('Scraping failed'))
      const res = await request(app).post('/api/combos/generate')
      expect(res.status).toBe(500)
      expect(res.body).toHaveProperty('error')
    })
  })

  describe('GET /api/combos/history', () => {
    it('returns combo history', async () => {
      const history = [
        { date: '2025-06-01', combos: [{ id: 1 }] },
        { date: '2025-05-31', combos: [{ id: 2 }] },
      ]
      jest.spyOn(comboService, 'loadHistory').mockResolvedValue(history)

      const res = await request(app).get('/api/combos/history')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect(res.body.length).toBe(2)
    })

    it('returns 500 on history error', async () => {
      jest.spyOn(comboService, 'loadHistory').mockRejectedValue(new Error('File missing'))
      const res = await request(app).get('/api/combos/history')
      expect(res.status).toBe(500)
      expect(res.body).toHaveProperty('error')
    })
  })
})
