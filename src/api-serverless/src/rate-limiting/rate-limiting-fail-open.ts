import { Logger } from '@/logging';
import { metricEnvironment } from '@/api/waves/wave-cache-metrics';

const logger = Logger.get('RATE_LIMIT_FAIL_OPEN');

export const RATE_LIMIT_FAIL_OPEN_REPORT_INTERVAL_MS = 60_000;

export type RateLimitFailOpenReason = 'redis_unavailable' | 'check_failed';

/**
 * A request admitted because its rate limit could not be checked. Requests
 * keep being served while Redis is unreachable; this keeps that visible
 * without one log line per request: the first event logs a warning and emits
 * a `6529/RateLimit FailOpen` metric, and later events in the same interval
 * are counted into the next report.
 */
export class RateLimitFailOpenReporter {
  private pending = new Map<RateLimitFailOpenReason, number>();
  private lastReportAt: number | null = null;

  constructor(
    private readonly intervalMs = RATE_LIMIT_FAIL_OPEN_REPORT_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  record(reason: RateLimitFailOpenReason): void {
    this.pending.set(reason, (this.pending.get(reason) ?? 0) + 1);
    const now = this.now();
    if (
      this.lastReportAt !== null &&
      now - this.lastReportAt < this.intervalMs
    ) {
      return;
    }
    this.lastReportAt = now;
    const counts = this.pending;
    this.pending = new Map();
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    try {
      logger.warn('rate_limit_fail_open', {
        requests: total,
        reasons: Object.fromEntries(counts),
        interval_ms: this.intervalMs
      });
      emitFailOpenMetric(total);
    } catch {
      // Reporting must never change whether the request is served.
    }
  }
}

function emitFailOpenMetric(count: number): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: '6529/RateLimit',
            Dimensions: [['Environment']],
            Metrics: [{ Name: 'FailOpen', Unit: 'Count' }]
          }
        ]
      },
      Environment: metricEnvironment(),
      FailOpen: count
    })}\n`
  );
}

export const rateLimitFailOpenReporter = new RateLimitFailOpenReporter();
