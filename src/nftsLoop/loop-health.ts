import { S3_UPLOADER_OUTBOX_TABLE } from '@/constants';
import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';
import { isS3UploaderEnabledForEnvironment } from '@/s3Uploader/s3-uploader.queue';

const MODES = {
  discover: { operation: 'discovery', interval: 60 },
  refresh: { operation: 'refresh', interval: 600 },
  audit: { operation: 'audit', interval: 3600 }
} as const;

/** Each scheduled mode owns its own completion. Verification of unchanged data
 * counts; attempted fetches, in-memory mutations and handler returns do not. */
export class NftsLoopHealth {
  private readonly startedAt = Math.floor(Date.now() / 1000);
  private progressAt: number | undefined;
  private incomplete = false;

  constructor(private readonly mode: keyof typeof MODES) {
    this.emit(true);
  }

  committed(): void {
    const now = Math.floor(Date.now() / 1000);
    // Audit callbacks can be numerous. Emit only after real work, at most once
    // per 30 seconds; there is no timer producing synthetic progress.
    if (this.progressAt !== undefined && now - this.progressAt < 30) return;
    this.progressAt = now;
    this.emit(true);
  }

  notCompleted(): void {
    this.incomplete = true;
  }

  verified(): void {
    if (!this.incomplete) this.committed();
  }

  completed(): void {
    this.emit(this.incomplete);
  }

  private emit(pending: boolean): void {
    reportLoopHealth({
      operation: MODES[this.mode].operation,
      pending,
      progressAt: this.progressAt,
      ...(!pending
        ? { nextDueAt: this.startedAt + MODES[this.mode].interval }
        : {}),
      // Starts/retries do not reset the collector's outstanding-work baseline.
      recovery: this.incomplete ? 'unknown' : 'automatic'
    });
  }
}

/** Publication is durable, shared by modes, and can fail below the publisher's
 * throwing threshold. A completed NFT pass must not clear that backlog. */
export async function observeNftPublication(): Promise<void> {
  try {
    if (!isS3UploaderEnabledForEnvironment()) {
      reportLoopHealth({
        operation: 'publication',
        pending: false,
        recovery: 'automatic'
      });
      return;
    }
    const [row] = await readLoopHealthRows<{ oldest: string | number | null }>(
      `select min(created_at) as oldest from ${S3_UPLOADER_OUTBOX_TABLE} where status = 'pending'`
    );
    if (row?.oldest === undefined) return;
    const oldest =
      row.oldest === null ? undefined : Math.floor(Number(row.oldest) / 1000);
    if (
      oldest !== undefined &&
      (!Number.isSafeInteger(oldest) ||
        oldest <= 0 ||
        oldest > Date.now() / 1000)
    )
      return;
    reportLoopHealth({
      operation: 'publication',
      pending: oldest !== undefined,
      oldestPendingAt: oldest,
      recovery: 'automatic'
    });
  } catch {
    // Best-effort writer survey; unknown evidence cannot establish recovery.
  }
}
