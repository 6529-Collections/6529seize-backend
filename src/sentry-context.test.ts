jest.mock('@sentry/serverless', () => ({
  AWSLambda: { wrapHandler: jest.fn() },
  captureException: jest.fn(),
  init: jest.fn()
}));

import * as Sentry from '@sentry/serverless';
import { captureException, wrapLambdaHandler } from './sentry.context';
import type { Context } from 'aws-lambda';

describe('Sentry context', () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalFunction = process.env.AWS_LAMBDA_FUNCTION_NAME;

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    if (originalFunction === undefined)
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = originalFunction;
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
  });

  it('still emits and preserves rejected invocation errors without configured Sentry', async () => {
    delete process.env.SENTRY_DSN;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'worker';
    const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = new Error('private request data');
    const wrapped = wrapLambdaHandler(async () => {
      throw error;
    });
    await expect(
      wrapped({}, { awsRequestId: 'request-123' } as Context, jest.fn())
    ).rejects.toBe(error);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
      code: 'LAMBDA_FAILURE',
      correlationId: 'request-123'
    });
    expect(String(output.mock.calls[0][0])).not.toContain('private');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('preserves local invocations without AWS context or callback', async () => {
    delete process.env.SENTRY_DSN;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    const context = undefined as unknown as Context;
    const callback = undefined as unknown as Parameters<
      ReturnType<typeof wrapLambdaHandler>
    >[2];
    const success = wrapLambdaHandler(async () => 'completed');
    await expect(success({}, context, callback)).resolves.toBe('completed');
    const original = new Error('local worker failure');
    const failure = wrapLambdaHandler(async () => {
      throw original;
    });
    await expect(failure({}, context, callback)).rejects.toBe(original);
  });

  it('preserves callback errors and intentional capture filtering', () => {
    delete process.env.SENTRY_DSN;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'worker';
    const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const error = new Error('expected validation');
    const callback = jest.fn();
    const wrapped = wrapLambdaHandler((_event, _context, done) => done(error), {
      shouldCaptureException: () => false
    });
    wrapped({}, { awsRequestId: 'request-123' } as Context, callback);
    expect(callback).toHaveBeenCalledWith(error, undefined);
    expect(output).not.toHaveBeenCalled();
  });

  it('preserves the invocation failure when a diagnostic filter throws', async () => {
    delete process.env.SENTRY_DSN;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'worker';
    jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const original = new Error('original failure');
    const wrapped = wrapLambdaHandler(
      async () => {
        throw original;
      },
      {
        shouldCaptureException: () => {
          throw new Error('filter failure');
        }
      }
    );
    await expect(
      wrapped({}, { awsRequestId: 'request' } as Context, jest.fn())
    ).rejects.toBe(original);
  });

  it('does not let capture failures change worker retry behavior', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    (Sentry.captureException as jest.Mock).mockImplementation(() => {
      throw new Error('Sentry transport failed');
    });

    expect(() =>
      captureException(new Error('Release note failed'))
    ).not.toThrow();
  });

  it('does not capture when Sentry is not configured', () => {
    delete process.env.SENTRY_DSN;

    captureException(new Error('Release note failed'));

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('enriches events using the original exception without capturing a second event', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    const error = new Error('Operator validation failed');
    const event = { type: undefined, message: error.message };
    const enriched = { ...event, tags: { code: 'IMPORT_FAILED' } };
    const enrichEvent = jest.fn(() => enriched);
    wrapLambdaHandler(async () => undefined, { enrichEvent });
    const beforeSend = jest.mocked(Sentry.init).mock.calls[0][0]!.beforeSend!;
    expect(beforeSend(event, { originalException: error })).toBe(enriched);
    expect(enrichEvent).toHaveBeenCalledWith(event, error);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.AWSLambda.wrapHandler).toHaveBeenCalledTimes(1);
  });

  it('preserves existing filtering before enrichment', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    const enrichEvent = jest.fn();
    wrapLambdaHandler(async () => undefined, {
      shouldCaptureException: () => false,
      enrichEvent
    });
    const beforeSend = jest.mocked(Sentry.init).mock.calls[0][0]!.beforeSend!;
    expect(
      beforeSend(
        { type: undefined },
        { originalException: new Error('Filtered') }
      )
    ).toBeNull();
    expect(enrichEvent).not.toHaveBeenCalled();
  });

  it('sanitizes the final enriched event before SDK transport', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    wrapLambdaHandler(async () => undefined, {
      enrichEvent: (event) => ({
        ...event,
        request: {
          url: 'https://api.example.com/api/drops?private=value',
          data: 'private evidence'
        },
        user: { id: 'private identity' }
      })
    });
    const options = jest.mocked(Sentry.init).mock.calls[0][0]!;
    expect(options.sendDefaultPii).toBe(false);
    expect(
      JSON.stringify(options.beforeSend!({ type: undefined }, {}))
    ).not.toContain('private');
  });

  it('preserves private route classification even when enrichment replaces request metadata', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    wrapLambdaHandler(async () => undefined, {
      enrichEvent: (event) => {
        event.request = { url: 'https://api.example.com/api/health' };
        event.extra = { evidence: 'private evidence' };
        return event;
      }
    });
    const beforeSend = jest.mocked(Sentry.init).mock.calls[0][0]!.beforeSend!;
    const result = beforeSend(
      {
        type: undefined,
        request: {
          url: 'https://api.example.com/api/content-moderation/checks/123'
        }
      },
      {}
    );
    expect(JSON.stringify(result)).not.toContain('private evidence');
    expect(result).toMatchObject({
      transaction: '/content-moderation/[private]'
    });
  });

  it('preserves events for existing callers without an enricher', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    wrapLambdaHandler(async () => undefined);
    const beforeSend = jest.mocked(Sentry.init).mock.calls[0][0]!.beforeSend!;
    const event = { type: undefined, message: 'Unrelated worker failed' };
    expect(beforeSend(event, {})).toBe(event);
  });
});
