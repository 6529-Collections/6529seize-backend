module.exports = {
  rootDir: '../..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/ops/ipfs/**/*.test.ts'],
  maxWorkers: 1,
  testTimeout: 30000
};
