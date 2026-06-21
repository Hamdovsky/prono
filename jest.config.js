module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'core/**/*.js',
    'services/**/*.js',
    'routes/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**',
    '!**/SofascoreScraping/**'
  ],
  coverageThreshold: {
    global: {
      branches: 10,
      functions: 10,
      lines: 15,
      statements: 10
    }
  },
  testMatch: [
    '**/__tests__/**/*.test.js'
  ],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 30000,
  maxWorkers: 2,
  modulePathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/SofascoreScraping/', '<rootDir>/\.kilo/'],
  verbose: true
};
