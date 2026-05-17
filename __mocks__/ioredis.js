const mockRedisInstance = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  flushall: jest.fn(),
  incr: jest.fn(),
  incrby: jest.fn(),
  on: jest.fn(),
  connect: jest.fn(),
  ping: jest.fn(),
  quit: jest.fn()
};

module.exports = jest.fn(() => mockRedisInstance);
