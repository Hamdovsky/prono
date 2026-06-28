/**
 * Security Engine Unit Tests
 * Tests for core/securityEngine.js - Rate limiting and authentication
 */

const securityEngine = require('../core/securityEngine');
const logger = require('../core/logger');

function mockReq(overrides = {}) {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { get: () => undefined, ...overrides.headers },
    url: '/test',
    ...overrides
  }
}
function mockRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() }
}

describe('SecurityEngine', () => {
  let secretBackup
  beforeAll(() => {
    secretBackup = process.env.API_SECRET_KEY
    process.env.API_SECRET_KEY = 'test-secret-key'
  })
  afterAll(() => {
    if (secretBackup === undefined) delete process.env.API_SECRET_KEY
    else process.env.API_SECRET_KEY = secretBackup
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('middleware (express-rate-limit)', () => {
    it('should call next() for allowed requests', done => {
      const req = mockReq({ ip: '127.0.0.1' })
      const res = mockRes()
      const next = jest.fn(() => {
        expect(next).toHaveBeenCalled()
        done()
      })

      securityEngine.middleware(req, res, next)
    })
  })

  describe('authenticate()', () => {
    it('should reject requests without Authorization header', () => {
      const req = mockReq({ headers: {} })
      const res = mockRes()
      const next = jest.fn()

      securityEngine.authenticate(req, res, next)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject requests with malformed Authorization header', () => {
      const req = mockReq({ headers: { authorization: 'InvalidToken' } })
      const res = mockRes()
      const next = jest.fn()

      securityEngine.authenticate(req, res, next)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('should reject requests with invalid token', () => {
      const req = mockReq({ headers: { authorization: 'Bearer wrong-token' } })
      const res = mockRes()
      const next = jest.fn()

      securityEngine.authenticate(req, res, next)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: Invalid security token' })
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow requests with valid token', () => {
      const req = mockReq({ headers: { authorization: 'Bearer test-secret-key' } })
      const res = mockRes()
      const next = jest.fn()

      securityEngine.authenticate(req, res, next)
      expect(next).toHaveBeenCalled()
    })
  })

  describe('handleProtocolMismatch()', () => {
    it('should handle invalid HTTP method errors', () => {
      const socket = { remoteAddress: '192.168.1.1', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'HPE_INVALID_METHOD', message: 'Invalid method' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.end).toHaveBeenCalled();
    });

    it('should handle connection reset errors', () => {
      const socket = { remoteAddress: '192.168.1.2', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'ECONNRESET', message: 'Connection reset' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.end).toHaveBeenCalled();
    });

    it('should destroy socket for other errors', () => {
      const socket = { remoteAddress: '192.168.1.3', end: jest.fn(), destroy: jest.fn() };
      const err = { code: 'UNKNOWN_ERROR', message: 'Unknown' };

      securityEngine.handleProtocolMismatch(err, socket);
      expect(socket.destroy).toHaveBeenCalled();
    });
  });
});
