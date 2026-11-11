import { Logger } from '@/logging';
import { RateLimitFailOpenReporter } from './rate-limiting-fail-open';

describe('RateLimitFailOpenReporter', () => {
  const originalFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  let warn: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  afterEach(() => {
    warn.mockRestore();
    stdout.mockRestore();
    if (originalFunctionName === undefined) {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    } else {
      process.env.AWS_LAMBDA_FUNCTION_NAME = originalFunctionName;
    }
  });

  it('warns on the first fail-open event and stays quiet within the interval', () => {
    let now = 1_000;
    const reporter = new RateLimitFailOpenReporter(60_000, () => now);

    reporter.record('redis_unavailable');
    for (let i = 0; i < 500; i++) {
      now += 10;
      reporter.record('redis_unavailable');
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('rate_limit_fail_open', {
      requests: 1,
      reasons: { redis_unavailable: 1 },
      interval_ms: 60_000
    });
  });

  it('reports what was suppressed in the next interval', () => {
    let now = 0;
    const reporter = new RateLimitFailOpenReporter(60_000, () => now);

    reporter.record('redis_unavailable');
    now = 1_000;
    reporter.record('redis_unavailable');
    reporter.record('check_failed');
    now = 61_000;
    reporter.record('check_failed');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('rate_limit_fail_open', {
      requests: 3,
      reasons: { redis_unavailable: 1, check_failed: 2 },
      interval_ms: 60_000
    });
  });

  it('emits a FailOpen metric with each report inside Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'api';
    const reporter = new RateLimitFailOpenReporter(60_000, () => 0);

    reporter.record('check_failed');
    reporter.record('check_failed');

    expect(stdout).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(stdout.mock.calls[0][0]));
    expect(record._aws.CloudWatchMetrics[0].Namespace).toBe('6529/RateLimit');
    expect(record.FailOpen).toBe(1);
  });

  it('never throws when logging fails', () => {
    warn.mockImplementation(() => {
      throw new Error('log sink unavailable');
    });
    const reporter = new RateLimitFailOpenReporter(60_000, () => 0);

    expect(() => reporter.record('redis_unavailable')).not.toThrow();
  });
});
