// Recovery, upload integrity and consumer checks require no database or AWS access.
module.exports = {
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: [
    '<rootDir>/src/arweave/**/*.test.ts',
    '<rootDir>/src/arweave-upload.test.ts',
    '<rootDir>/src/tdhLoop/tdh-arweave-upload.test.ts',
    '<rootDir>/src/decentralized-media/*.test.ts',
    '<rootDir>/src/nft-links/lib/*http*.test.ts',
    '<rootDir>/src/nft-links/nft-preview-*.test.ts',
    '<rootDir>/src/nft-links/nft-link-media-preview.test.ts',
    '<rootDir>/src/profile-cms/profile-cms-publication-storage.test.ts',
    '<rootDir>/src/media/image-download.test.ts',
    '<rootDir>/src/nft-history/metadata*.test.ts',
    '<rootDir>/src/s3-rememes.test.ts',
    '<rootDir>/src/s3.test.ts',
    '<rootDir>/src/http/safe-fetch.test.ts',
    '<rootDir>/src/api-serverless/src/health/health-service.test.ts'
  ],
  testPathIgnorePatterns: [String.raw`\.db\.test\.ts$`],
  testTimeout: 30000,
  maxWorkers: 2
};
