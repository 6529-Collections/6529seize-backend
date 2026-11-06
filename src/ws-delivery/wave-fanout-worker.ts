import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { Logger } from '@/logging';
import {
  DropCreatedEffectsJob,
  DropFramesJob,
  parseWaveFanoutJob
} from './wave-fanout-job';

const logger = Logger.get('WAVE_FANOUT_WORKER');

export interface WaveFanoutWorkerDeps {
  readonly deliverQueuedDropFrames: (job: DropFramesJob) => Promise<void>;
  readonly runDropCreatedEffects: (job: DropCreatedEffectsJob) => Promise<void>;
}

/**
 * Processes one SQS batch for the wave fan-out worker (waves 1.1). Records
 * run in parallel; a record that throws is reported back to SQS for a retry
 * (and the DLQ after the redrive limit), the others are acknowledged.
 * Drop-frame chunks only throw before their first send, so a retry never
 * repeats frames that were already delivered.
 */
export async function processWaveFanoutBatch(
  event: SQSEvent,
  deps: WaveFanoutWorkerDeps
): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const job = parseWaveFanoutJob(record.body);
        if (job.kind === 'drop_frames') {
          await deps.deliverQueuedDropFrames(job);
        } else {
          await deps.runDropCreatedEffects(job);
        }
      } catch (error) {
        try {
          logger.error({
            code: 'WAVE_FANOUT_JOB_FAILED',
            message_id: record.messageId,
            receive_count: record.attributes?.ApproximateReceiveCount ?? null,
            error_type: error instanceof Error ? error.name : typeof error,
            error_message: error instanceof Error ? error.message : null
          });
        } catch {
          /* Reporting must not change the retry decision. */
        }
        failures.push({ itemIdentifier: record.messageId });
      }
    })
  );
  return { batchItemFailures: failures };
}
