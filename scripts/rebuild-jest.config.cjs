// The rebuild harness's end-to-end check. It starts its own private mysqld
// (see docs/rebuild-check.md), so it has no container setup and stays out of
// the default test run.
module.exports = {
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: ['<rootDir>/src/rebuild/**/*.rebuild.test.ts'],
  testTimeout: 15 * 60 * 1000,
  maxWorkers: 1
};
