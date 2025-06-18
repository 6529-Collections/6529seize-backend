import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts?$': 'ts-jest'
  },
  transformIgnorePatterns: ['<rootDir>/node_modules/'],
  testPathIgnorePatterns: ['<rootDir>/build/'],
  globalSetup: './src/tests/_setup/globalSetup.ts',
  globalTeardown: './src/tests/_setup/globalTeardown.ts',
  setupFilesAfterEnv: ['./src/tests/_setup/perTestHooks.ts']
};

export default config;
