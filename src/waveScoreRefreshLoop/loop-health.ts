import {
  WAVE_METRICS_TABLE,
  WAVE_SCORE_REFRESH_REQUESTS_TABLE
} from '@/constants';
import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';

/** New writes and failed attempts cannot advance the business-progress clock.
 * A request remains outstanding since its first dirty mark or the last persisted
 * score calculation, whichever is later. Re-dirtying preserves created_at. */
export async function observeDirtyRefreshBacklog(): Promise<void> {
  try {
    const rows = await readLoopHealthRows<{ oldest: number | string | null }>(
      `select min(greatest(request.created_at, coalesce(metric.wave_score_calculated_at, 0))) as oldest
       from ${WAVE_SCORE_REFRESH_REQUESTS_TABLE} request
       left join ${WAVE_METRICS_TABLE} metric on metric.wave_id = request.wave_id`
    );
    // An aggregate over an empty backlog returns null. A missing row is unknown.
    if (rows[0]?.oldest === undefined) return;
    const oldest =
      rows[0].oldest !== null
        ? Math.floor(Number(rows[0].oldest) / 1000)
        : undefined;
    const now = Math.floor(Date.now() / 1000);
    if (
      oldest !== undefined &&
      (!Number.isSafeInteger(oldest) || oldest <= 0 || oldest > now)
    )
      return;
    reportLoopHealth({
      operation: 'dirty_refresh',
      pending: oldest !== undefined,
      ...(oldest !== undefined ? { oldestPendingAt: oldest } : {}),
      // The existing one-minute fallback retries persisted dirty work even if
      // a wakeup or continuation enqueue fails. A return is not progress.
      recovery: 'automatic'
    });
  } catch {
    // Failed diagnostics leave business health unknown; never fail the worker.
  }
}

/** An observed full scan and its continuation chain are separate from dirty work.
 * Waiting full requests retain the independent SQS age alarm. Only a completed
 * full scan clears this operation; a dirty invocation never clears it. */
export class FullRefreshHealth {
  private progressAt: number | undefined;

  constructor(
    readonly startedAt: number,
    private readonly automaticRetry: boolean
  ) {
    this.emit(true, this.retryRecovery());
  }

  committed(waves: number): void {
    if (waves > 0) this.progressAt = Math.floor(Date.now() / 1000);
    // An SQS input can replay if enqueue fails; a direct invocation cannot.
    this.emit(true, this.retryRecovery());
  }

  continued(): void {
    this.emit(true, 'automatic');
  }

  completed(): void {
    this.emit(false, 'automatic');
  }

  failed(): void {
    // Scheduled dirty runs cannot replay a failed direct full scan.
    this.emit(true, this.automaticRetry ? 'automatic' : 'unavailable');
  }

  private retryRecovery(): 'automatic' | 'unknown' {
    return this.automaticRetry ? 'automatic' : 'unknown';
  }

  private emit(
    pending: boolean,
    recovery: 'automatic' | 'unknown' | 'unavailable'
  ): void {
    reportLoopHealth({
      operation: 'full_refresh',
      pending,
      ...(pending ? { oldestPendingAt: this.startedAt } : {}),
      progressAt: this.progressAt,
      recovery
    });
  }
}
