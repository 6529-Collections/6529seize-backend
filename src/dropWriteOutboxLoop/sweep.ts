import { Logger } from '@/logging';
import {
  dropWriteOutboxDb,
  DropWriteOutboxDb
} from '@/drops/drop-write-outbox.db';
import {
  DROP_WRITE_OUTBOX_LEASE_MS,
  dropWriteOutboxProcessor,
  DropWriteOutboxProcessor
} from '@/drops/drop-write-outbox.processor';

const logger = Logger.get('DROP_WRITE_OUTBOX_LOOP');

/** Rows younger than this are still the worker's (waves 1.8 fast path). */
export const DROP_WRITE_OUTBOX_SWEEP_AFTER_MS = 30_000;
/** A backlog older than this is reported as an error for alerting. */
export const DROP_WRITE_OUTBOX_BACKLOG_ALERT_MS = 5 * 60_000;

export interface SweepResult {
  readonly processed: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * The post outbox backstop: finishes rows the worker never got to (a lost
 * hand-off, a Lambda that died after the drop committed, or a failed run
 * whose lease expired). Each row goes through the same claim-and-fence
 * processor, so overlapping the worker never duplicates work.
 */
export async function sweepDropWriteOutbox({
  db = dropWriteOutboxDb,
  processor = dropWriteOutboxProcessor,
  batchSize = 100,
  deadlineMs = 40_000,
  now = () => Date.now()
}: {
  db?: Pick<
    DropWriteOutboxDb,
    'findDue' | 'oldestPendingAt' | 'quarantineExhausted'
  >;
  processor?: Pick<DropWriteOutboxProcessor, 'process'>;
  batchSize?: number;
  deadlineMs?: number;
  now?: () => number;
} = {}): Promise<SweepResult> {
  const deadline = now() + deadlineMs;
  const oldest = await db.oldestPendingAt({
    leaseMs: DROP_WRITE_OUTBOX_LEASE_MS
  });
  if (oldest !== null && now() - oldest > DROP_WRITE_OUTBOX_BACKLOG_ALERT_MS) {
    const error = new Error(
      'Committed drop writes have waited over five minutes for their outbox work'
    );
    error.name = 'DropWriteOutbox.BACKLOG';
    logger.error(error.message, error);
  }
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  while (now() < deadline) {
    const ids = await db.findDue({
      olderThanMs: DROP_WRITE_OUTBOX_SWEEP_AFTER_MS,
      leaseMs: DROP_WRITE_OUTBOX_LEASE_MS,
      limit: batchSize
    });
    if (!ids.length) break;
    let progressed = 0;
    for (const id of ids) {
      if (now() >= deadline) break;
      try {
        const outcome = await processor.process(id);
        if (outcome === 'processed') {
          processed++;
          progressed++;
        } else {
          skipped++;
        }
      } catch (error) {
        failed++;
        logger.error(`Post outbox row ${id} failed in the sweeper`, error);
      }
    }
    // Rows that failed or are leased elsewhere stay due; stop rather than spin.
    if (!progressed || ids.length < batchSize) break;
  }
  // A row that keeps failing is retried up to the attempt limit, then
  // quarantined and reported once, not failed (and alarmed) every minute.
  const quarantined = await db.quarantineExhausted({
    leaseMs: DROP_WRITE_OUTBOX_LEASE_MS
  });
  if (quarantined > 0) {
    const error = new Error(
      `${quarantined} post outbox row(s) used up their attempts and were quarantined`
    );
    error.name = 'DropWriteOutbox.QUARANTINED';
    logger.error(error.message, error);
  }
  logger.info({ processed, skipped, failed });
  return { processed, skipped, failed };
}
