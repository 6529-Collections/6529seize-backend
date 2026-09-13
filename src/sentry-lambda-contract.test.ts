jest.mock('@sentry/serverless', () => {
  const sdk =
    jest.requireActual<typeof import('@sentry/serverless')>(
      '@sentry/serverless'
    );
  // Exercise the real Lambda wrapper without initializing outbound telemetry.
  return { ...sdk, init: jest.fn() };
});

import type { Context, Handler } from 'aws-lambda';
import { BadRequestException } from './exceptions';
import { operationalResponse } from './operational-errors';
import { wrapLambdaHandler } from './sentry.context';

const invocation = (): Context => ({
  awsRequestId: 'contract-request',
  functionName: 'contract-worker',
  functionVersion: '$LATEST',
  invokedFunctionArn:
    'arn:aws:lambda:us-east-1:123456789012:function:contract-worker',
  memoryLimitInMB: '512',
  logGroupName: '/aws/lambda/contract-worker',
  logStreamName: 'contract-stream',
  callbackWaitsForEmptyEventLoop: false,
  getRemainingTimeInMillis: () => 30000,
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn()
});

describe.each([false, true])(
  'Lambda invocation contract with Sentry configured=%s',
  (configured) => {
    const originalEnvironment = process.env;
    let output: jest.SpyInstance;

    beforeEach(() => {
      process.env = {
        ...originalEnvironment,
        AWS_LAMBDA_FUNCTION_NAME: 'contract-worker'
      };
      if (configured) process.env.SENTRY_DSN = 'https://contract@localhost/1';
      else delete process.env.SENTRY_DSN;
      output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    });

    afterEach(() => {
      process.env = originalEnvironment;
      jest.restoreAllMocks();
    });

    it.each([200, 204, 401, 503])(
      'preserves status %s, CORS headers, cookies and body',
      async (statusCode) => {
        const response = Object.freeze({
          statusCode,
          body: 'opaque body',
          headers: Object.freeze({
            'Access-Control-Allow-Origin': 'https://application.example',
            'Access-Control-Allow-Headers': 'Idempotency-Key',
            'Set-Cookie': 'opaque-cookie'
          }),
          multiValueHeaders: Object.freeze({
            'Set-Cookie': ['first', 'second']
          }),
          cookies: ['third'],
          isBase64Encoded: false
        });
        const wrapped = wrapLambdaHandler(async () =>
          operationalResponse(response)
        );
        expect(await wrapped({}, invocation(), jest.fn())).toBe(response);
        expect(output).toHaveBeenCalledTimes(statusCode >= 500 ? 1 : 0);
      }
    );

    it('preserves SQS partial batch failure identifiers', async () => {
      const response = {
        batchItemFailures: [{ itemIdentifier: 'failed-record' }]
      };
      const wrapped = wrapLambdaHandler(async () => response);
      expect(await wrapped({}, invocation(), jest.fn())).toBe(response);
    });

    it('preserves callback success', async () => {
      const result = { accepted: true };
      const callback = jest.fn();
      const wrapped = wrapLambdaHandler((_event, _context, done) =>
        done(null, result)
      );
      const response = wrapped({}, invocation(), callback);
      if (configured) expect(await response).toBe(result);
      else expect(callback).toHaveBeenCalledWith(null, result);
      expect(output).not.toHaveBeenCalled();
    });

    it('preserves callback error identity', async () => {
      const original = new Error('original failure');
      const callback = jest.fn();
      const wrapped = wrapLambdaHandler((_event, _context, done) =>
        done(original)
      );
      const response = wrapped({}, invocation(), callback);
      if (configured) await expect(response).rejects.toBe(original);
      else expect(callback).toHaveBeenCalledWith(original, undefined);
      expect(output).toHaveBeenCalledTimes(1);
    });

    it.each(['sync', 'async'])(
      'preserves %s failure when diagnostic output throws',
      async (kind) => {
        output.mockImplementation(() => {
          throw new Error('stdout unavailable');
        });
        const original = new Error('original invocation failure');
        const handler: Handler =
          kind === 'sync'
            ? () => {
                throw original;
              }
            : async () => {
                throw original;
              };
        const wrapped = wrapLambdaHandler(handler);
        const call = () => wrapped({}, invocation(), jest.fn());
        if (kind === 'sync' && !configured) expect(call).toThrow(original);
        else await expect(call()).rejects.toBe(original);
      }
    );

    it('preserves typed client-error rejection without reporting it', async () => {
      const original = new BadRequestException('ordinary rejection');
      const wrapped = wrapLambdaHandler(async () => {
        throw original;
      });
      await expect(wrapped({}, invocation(), jest.fn())).rejects.toBe(original);
      expect(output).not.toHaveBeenCalled();
    });
  }
);
