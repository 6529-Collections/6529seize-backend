// Database-independent checks. The default repository suite owns MySQL integration.
module.exports = {
  rootDir: '../..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1', '^@/(.*)$': '<rootDir>/src/$1' },
  testMatch: ['<rootDir>/src/nft-history/*.test.ts', '<rootDir>/src/nftHistoryLoop/*.test.ts', '<rootDir>/src/tests/nft-history.test.ts', '<rootDir>/src/dbMigrationsLoop/schema-scope.test.ts', '<rootDir>/src/ethereum-rpc/ethereum-rpc-client.test.ts'],
  testPathIgnorePatterns: ['\\.db\\.test\\.ts$'],
  maxWorkers: 1
};
