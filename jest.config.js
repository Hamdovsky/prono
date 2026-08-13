module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'core/**/*.js',
    'services/**/*.js',
    'routes/**/*.js',
    '!**/*.test.js',
    '!**/node_modules/**',
    '!**/SofascoreScraping/**',
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 70,
      statements: 60,
    },
  },
  testMatch: ['**/__tests__/**/*.test.js', '**/tests/**/*.test.js'],
  // setupFiles runs BEFORE any test file is required (guarantees SQLITE_DB_PATH
  // is set before core/database.js module-level `const dbPath` executes).
  setupFiles: ['<rootDir>/__tests__/db-isolation.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  testTimeout: 30000,
  maxWorkers: 2,
  modulePathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/SofascoreScraping/',
    '<rootDir>/\.kilo/',
  ],
  verbose: true,
}
