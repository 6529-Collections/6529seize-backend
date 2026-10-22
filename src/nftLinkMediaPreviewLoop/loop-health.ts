import { NFT_LINKS_TABLE } from '@/constants';
import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';

type DbTimestamp = number | string | null;

/** Survey the writer, not handler return values or retry/lease timestamps.
 * Terminal asset failures retain APPLICATION_ERROR; this operation describes
 * outstanding preview processing, not recovery of a failed individual asset. */
export async function observePreviewBacklog(): Promise<void> {
  try {
    const [row] = await readLoopHealthRows<{
      pending: number | string;
      unknown_age: number | string;
      oldest: DbTimestamp;
      progress: DbTimestamp;
    }>(`select
      count(case when media_preview_status in ('PENDING', 'PROCESSING') then 1 end) as pending,
      count(case when media_preview_status in ('PENDING', 'PROCESSING') and media_preview_queued_at is null then 1 end) as unknown_age,
      min(case when media_preview_status in ('PENDING', 'PROCESSING') then media_preview_queued_at end) as oldest,
      max(case when media_preview_status = 'READY' then media_preview_last_success_at end) as progress
      from ${NFT_LINKS_TABLE}`);
    if (
      !row ||
      !Number.isSafeInteger(Number(row.pending)) ||
      Number(row.pending) < 0 ||
      Number(row.unknown_age) !== 0
    )
      return;
    const seconds = (value: DbTimestamp) =>
      value === null ? undefined : Math.floor(Number(value) / 1000);
    const oldest = seconds(row.oldest);
    const progress = seconds(row.progress);
    if (
      [oldest, progress].some(
        (value) =>
          value !== undefined &&
          (!Number.isSafeInteger(value) ||
            value <= 0 ||
            value > Date.now() / 1000)
      )
    )
      return;
    if (Number(row.pending) > 0 && oldest === undefined) return;
    reportLoopHealth({
      operation: 'processing',
      pending: Number(row.pending) > 0,
      oldestPendingAt: oldest,
      // A READY result predating all active work belongs to an earlier episode.
      // Repeated surveys must not reintroduce that historical success as the
      // new backlog's stall clock. Real progress during older work is retained.
      progressAt:
        oldest !== undefined && progress !== undefined && progress < oldest
          ? undefined
          : progress,
      // A DB PENDING row alone cannot prove that its SQS send succeeded or
      // that it still has a deliverable message. Never invent automatic retry.
      recovery: Number(row.pending) > 0 ? 'unknown' : 'automatic'
    });
  } catch {
    // A missing/expired survey leaves the previous evidence unchanged.
  }
}
