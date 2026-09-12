// Codec/multipart checks have no database dependency and also run on native OS CI.
module.exports = {
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/api/(.*)$': '<rootDir>/src/api-serverless/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testMatch: [
    '<rootDir>/src/media/media-runtime.test.ts',
    '<rootDir>/src/media/media-dependency-smoke.test.ts',
    '<rootDir>/src/mediaResizerLoop/media-resizer-runtime.test.ts',
    '<rootDir>/src/nft-links/nft-link-media-preview.test.ts',
    '<rootDir>/src/artwork-documentation/assets/artwork-assets-processor.test.ts',
    '<rootDir>/src/artwork-documentation/assets/artwork-assets-av.test.ts',
    '<rootDir>/src/api-serverless/src/multer-middleware.test.ts'
  ],
  testTimeout: 30000,
  maxWorkers: 1
};
