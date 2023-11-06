import type { AWS } from '@serverless/typescript';

import { handler } from './src/handler';
import * as process from 'process';

const serverlessConfiguration: AWS = {
  useDotenv: true,
  service: 'api-serverless',
  frameworkVersion: '3',
  plugins: [
    'serverless-esbuild',
    'serverless-offline',
    'serverless-dotenv-plugin'
  ],
  provider: {
    name: 'aws',
    runtime: 'nodejs14.x',
    apiGateway: {
      minimumCompressionSize: 1024,
      shouldStartNameWithService: true
    },
    environment: {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps --stack-trace-limit=1000',
      DB_HOST: process.env.DB_HOST,
      DB_HOST_READ: process.env.DB_HOST_READ,
      DB_NAME: process.env.DB_NAME,
      DB_PASS: process.env.DB_PASS,
      DB_PASS_READ: process.env.DB_PASS_READ,
      DB_PORT: process.env.DB_PORT,
      DB_USER: process.env.DB_USER,
      DB_USER_READ: process.env.DB_USER_READ,
      SENTRY_DSN: process.env.SENTRY_DSN,
      SEIZE_API_VERSION: process.env.SEIZE_API_VERSION,
      API_LOAD_SECRETS: 'true'
    }
  },
  // import the function via paths
  functions: { handler: handler as any },
  package: { individually: true },
  custom: {
    esbuild: {
      bundle: true,
      minify: false,
      sourcemap: true,
      exclude: ['aws-sdk'],
      target: 'node14',
      define: { 'require.resolve': undefined },
      platform: 'node',
      concurrency: 10
    }
  }
};

module.exports = serverlessConfiguration;
