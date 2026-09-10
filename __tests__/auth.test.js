const express = require('express')
const request = require('supertest')

jest.mock('../services/authService', () => ({
  register: jest.fn(),
  login: jest.fn(),
  authenticate: jest.fn((req, res, next) => {
    req.user = { username: 'testuser', role: 'user' }
    next()
  }),
  // userCount() de routes/auth : compteur piloté par global.__USERS_N__
  getDb: jest.fn(() => ({
    prepare: () => ({ get: async () => ({ n: global.__USERS_N__ ?? 1 }) }),
  })),
}))

jest.mock('../core/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}))

const authService = require('../services/authService')
const authRouter = require('../routes/auth')

let app
beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
})

afterEach(() => {
  jest.restoreAllMocks()
  delete global.__USERS_N__
})

describe('Auth Routes', () => {
  describe('POST /api/auth/register', () => {
    it('registers with valid credentials (bootstrap : 1er compte = admin)', async () => {
      global.__USERS_N__ = 0
      jest
        .spyOn(authService, 'register')
        .mockResolvedValue({ token: 'abc123', user: { username: 'newuser' } })

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: 'password123' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body).toHaveProperty('token')
      // le bootstrap impose le rôle admin au 1er compte
      expect(authService.register).toHaveBeenCalledWith(
        'newuser',
        undefined,
        'password123',
        'admin'
      )
    })

    it('É10: 2e compte SANS token admin => 401', async () => {
      global.__USERS_N__ = 5
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'intru', password: 'password123' })
      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/admin token/)
    })

    it('É10: 2e compte AVEC token admin => accepté, rôle user', async () => {
      global.__USERS_N__ = 5
      process.env.API_SECRET_KEY = 'root-secret'
      jest.spyOn(authService, 'register').mockResolvedValue({ token: 't2' })
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'guest', password: 'password123' })
        .set('Authorization', 'Bearer root-secret')
      expect(res.status).toBe(200)
      expect(authService.register).toHaveBeenCalledWith('guest', undefined, 'password123', 'user')
      delete process.env.API_SECRET_KEY
    })

    it('rejects missing username', async () => {
      const res = await request(app).post('/api/auth/register').send({ password: 'password123' })

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Username and password required/)
    })

    it('rejects missing password', async () => {
      const res = await request(app).post('/api/auth/register').send({ username: 'newuser' })

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Username and password required/)
    })

    it('rejects short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: '123' })

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/at least 6/)
    })

    it('returns 400 on duplicate username', async () => {
      global.__USERS_N__ = 0
      jest.spyOn(authService, 'register').mockRejectedValue(new Error('Username already exists'))

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'existing', password: 'password123' })

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/already exists/)
    })
  })

  describe('POST /api/auth/login', () => {
    it('logs in with valid credentials', async () => {
      jest
        .spyOn(authService, 'login')
        .mockResolvedValue({ token: 'xyz789', user: { username: 'testuser' } })

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'password123' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body).toHaveProperty('token')
    })

    it('rejects missing credentials', async () => {
      const res = await request(app).post('/api/auth/login').send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/Username and password required/)
    })

    it('returns 401 on wrong password', async () => {
      jest.spyOn(authService, 'login').mockRejectedValue(new Error('Invalid credentials'))

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'testuser', password: 'wrongpassword' })

      expect(res.status).toBe(401)
      expect(res.body.error).toMatch(/Invalid credentials/)
    })
  })

  describe('GET /api/auth/me', () => {
    it('returns user info when authenticated', async () => {
      const res = await request(app).get('/api/auth/me')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body).toHaveProperty('user')
      expect(res.body.user).toHaveProperty('username')
    })

    it('auth middleware is called', async () => {
      await request(app).get('/api/auth/me')
      expect(authService.authenticate).toHaveBeenCalled()
    })
  })
})
