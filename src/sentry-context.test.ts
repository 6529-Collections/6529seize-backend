jest.mock('@sentry/serverless', () => ({
  AWSLambda: { wrapHandler: jest.fn() },
  captureException: jest.fn(),
  init: jest.fn()
}));

import * as Sentry from '@sentry/serverless';
import { captureException } from './sentry.context';

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
});
