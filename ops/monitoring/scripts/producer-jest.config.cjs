// Source emitter tests use the backend's test dependencies, without starting its database.
module.exports = {
  rootDir: require('node:path').resolve(__dirname, '../../..'),
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: [
    '<rootDir>/src/operational-errors.test.ts',
    '<rootDir>/src/sentry-context.test.ts',
    '<rootDir>/src/tests/subscriptions.test.ts'
  ],
  maxWorkers: 1
};
