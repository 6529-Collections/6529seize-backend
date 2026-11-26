// Claims recovery checks use mocked persistence and transport; no database or AWS.
module.exports = {
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: [
    '<rootDir>/src/minting-claims/claims-media-*.test.ts',
    '<rootDir>/src/claimsMediaArweaveUploader/*.test.ts',
    '<rootDir>/src/dbMigrationsLoop/claims-media-schema.test.ts',
    '<rootDir>/src/arweave-upload.test.ts',
    '<rootDir>/src/api-serverless/src/minting-claims/api-minting-claims-db.test.ts'
  ],
  maxWorkers: 2,
  testTimeout: 30000
};
