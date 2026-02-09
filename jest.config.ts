import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.ts?$': 'ts-jest'
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/'],
  testPathIgnorePatterns: ['<rootDir>/build/'],
  globalSetup: './src/tests/_setup/globalSetup.ts',
  globalTeardown: './src/tests/_setup/globalTeardown.ts',
  setupFilesAfterEnv: ['./src/tests/_setup/perTestHooks.ts'],
  // Increase timeout for graceful shutdown of database connections and containers
  testTimeout: 30000,
  // Force exit after tests to prevent hanging on open handles
  // This is safe because globalTeardown handles cleanup
  forceExit: true,
  // Reduce workers to minimize connection pool issues
  maxWorkers: '50%',
  // Suppress worker exit warnings (known issue with testcontainers)
  // Resources are properly cleaned up in globalTeardown
  detectOpenHandles: false
};

export default config;
