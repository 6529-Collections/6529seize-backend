import { registerWaveJobHandler } from '@/ws-delivery/wave-fanout-worker';
import {
  asDropWriteOutboxJob,
  DROP_WRITE_OUTBOX_JOB_KIND
} from './drop-write-outbox.hand-off';
import { dropWriteOutboxProcessor } from './drop-write-outbox.processor';

/**
 * Registers the post outbox job with the wave fan-out worker (waves 1.8).
 * A job whose row is already done or leased elsewhere succeeds as a no-op;
 * a failure throws so SQS retries it, and the sweeper remains the backstop.
 */
export function registerDropWriteOutboxJob(): void {
  registerWaveJobHandler(DROP_WRITE_OUTBOX_JOB_KIND, async (job) => {
    await dropWriteOutboxProcessor.process(asDropWriteOutboxJob(job).outbox_id);
  });
}
