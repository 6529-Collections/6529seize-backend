import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  waveFanoutQueue,
  WaveFanoutQueue
} from '@/ws-delivery/wave-fanout-queue';
import type { WaveFanoutJob } from '@/ws-delivery/wave-fanout-job';

export const DROP_WRITE_OUTBOX_JOB_KIND = 'drop_write_outbox';

export interface DropWriteOutboxJob {
  readonly v: 1;
  readonly kind: typeof DROP_WRITE_OUTBOX_JOB_KIND;
  readonly enqueued_at: number;
  readonly outbox_id: number;
  readonly drop_id: string;
  readonly wave_id: string;
}

export function asDropWriteOutboxJob(
  job: Record<string, unknown>
): DropWriteOutboxJob {
  const outboxId = Number(job.outbox_id);
  if (
    job.kind !== DROP_WRITE_OUTBOX_JOB_KIND ||
    !Number.isSafeInteger(outboxId) ||
    outboxId <= 0 ||
    typeof job.drop_id !== 'string' ||
    typeof job.wave_id !== 'string'
  ) {
    throw new Error('Invalid drop_write_outbox job');
  }
  return {
    v: 1,
    kind: DROP_WRITE_OUTBOX_JOB_KIND,
    enqueued_at: Number(job.enqueued_at) || 0,
    outbox_id: outboxId,
    drop_id: job.drop_id,
    wave_id: job.wave_id
  };
}

const logger = Logger.get('DROP_WRITE_OUTBOX_HAND_OFF');

/**
 * After-commit stage 3 for a drop write (waves 1.8): only hands the outbox
 * row to the wave fan-out worker. It never does the work in the request.
 * A rejected hand-off is left to the dropWriteOutboxLoop sweeper.
 */
export async function handOffDropWriteOutbox(
  {
    outboxId,
    dropId,
    waveId
  }: { outboxId: number | null | undefined; dropId: string; waveId: string },
  _ctx: RequestContext,
  queue: WaveFanoutQueue = waveFanoutQueue
): Promise<'queued' | 'left_to_sweeper' | 'nothing'> {
  if (!outboxId) return 'nothing';
  const job: DropWriteOutboxJob = {
    v: 1,
    kind: DROP_WRITE_OUTBOX_JOB_KIND,
    enqueued_at: Date.now(),
    outbox_id: outboxId,
    drop_id: dropId,
    wave_id: waveId
  };
  // The queue serializes any job body; the worker dispatches by kind.
  const rejected = await queue.enqueue([job as unknown as WaveFanoutJob]);
  if (rejected.length) {
    logger.warn({
      code: 'DROP_WRITE_OUTBOX_HAND_OFF_DEFERRED',
      outbox_id: outboxId,
      drop_id: dropId
    });
    return 'left_to_sweeper';
  }
  return 'queued';
}
