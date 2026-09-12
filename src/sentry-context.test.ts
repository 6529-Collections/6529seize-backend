jest.mock('@sentry/serverless', () => ({
  AWSLambda: { wrapHandler: jest.fn() },
  captureException: jest.fn(),
  init: jest.fn()
}));

import * as Sentry from '@sentry/serverless';
import { captureException, wrapLambdaHandler } from './sentry.context';

describe('Sentry context', () => {
  const originalDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
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

  it('preserves events for existing callers without an enricher', () => {
    process.env.SENTRY_DSN = 'https://example.com/sentry';
    wrapLambdaHandler(async () => undefined);
    const beforeSend = jest.mocked(Sentry.init).mock.calls[0][0]!.beforeSend!;
    const event = { type: undefined, message: 'Unrelated worker failed' };
    expect(beforeSend(event, {})).toBe(event);
  });
});
