// Jest Test Setup
// Global mocks and test utilities for Promosport AI

// Mock ioredis globally
jest.mock('ioredis', () => {
  // Create mock instance inside factory
  const mockRedis = {
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

  return {
    Redis: jest.fn(() => mockRedis),
    // Also expose mock instance for tests to access directly if needed
    mockInstance: mockRedis
  };
});

// Mock redis-memory-server
jest.mock('redis-memory-server', () => ({
  RedisMemoryServer: jest.fn().mockImplementation(() => ({
    getHost: jest.fn().mockResolvedValue('127.0.0.1'),
    getPort: jest.fn().mockResolvedValue(6379),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined)
  }))
}));

// Mock fs - use jest.requireActual inside factory to avoid scope violation
const mockFs = () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    existsSync: jest.fn((path) => {
      if (path.includes('logs')) return false;
      // For data dir checks, return false by default to avoid IO in tests
      return false;
    }),
    mkdirSync: jest.fn(),
    appendFileSync: jest.fn(),
    readdirSync: jest.fn(() => []),
    statSync: jest.fn(() => ({ size: 0, mtimeMs: Date.now() })),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
    readFileSync: jest.fn(() => '{}'),
    writeFileSync: jest.fn()
  };
};

jest.mock('fs', () => mockFs());

// Mock performance if not available
if (typeof performance === 'undefined') {
  global.performance = {
    now: jest.fn(() => Date.now())
  };
}

// Test environment variables
process.env.NODE_ENV = 'test';
process.env.API_SECRET_KEY = 'test-secret-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.TELEGRAM_CHAT_ID = 'test-chat-id';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';

// Global mock utilities
global.createMockRedis = () => ({
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
});
