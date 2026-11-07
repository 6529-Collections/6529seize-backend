import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { Logger } from '@/logging';
import { emitWaveJobMetrics } from './wave-delivery-metrics';
import { parseWaveJobEnvelope } from './wave-fanout-job';

const logger = Logger.get('WAVE_FANOUT_WORKER');

/**
 * Handles one queued job of a registered kind. It validates its own body and
 * throws to have SQS retry the message (and dead-letter it after the redrive
 * limit). Drop-frame handlers throw only before their first send.
 */
export type WaveJobHandler = (job: Record<string, unknown>) => Promise<void>;

/**
 * Job kinds the wave fan-out worker runs. A body without `kind` is a drop
 * fan-out chunk. Other modules register their own kinds (for example the
 * waves 1.8 post outbox) instead of editing a switch here.
 */
export class WaveJobRegistry {
  private readonly handlers = new Map<string, WaveJobHandler>();

  register(kind: string, handler: WaveJobHandler): void {
    if (!kind) throw new Error('Wave job kind is required');
    if (this.handlers.has(kind))
      throw new Error(`Wave job kind ${kind} is already registered`);
    this.handlers.set(kind, handler);
  }

  handlerFor(kind: string): WaveJobHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`Unknown wave job kind ${kind}`);
    return handler;
  }
}

export const waveJobRegistry = new WaveJobRegistry();

export function registerWaveJobHandler(
  kind: string,
  handler: WaveJobHandler
): void {
  waveJobRegistry.register(kind, handler);
}

function receivedAgeMs(sentTimestamp: string | undefined): number | null {
  const sentAt = Number(sentTimestamp);
  return Number.isFinite(sentAt) && sentAt > 0 ? Date.now() - sentAt : null;
}

/**
 * Processes one SQS batch. Records run in parallel; a record that throws,
 * has no parseable body or an unknown kind is reported back to SQS on its
 * own (partial batch failure), so the other records are acknowledged.
 */
export async function processWaveFanoutBatch(
  event: SQSEvent,
  registry: WaveJobRegistry = waveJobRegistry
): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      let kind = 'unparsed';
      const queueAgeMs = receivedAgeMs(record.attributes?.SentTimestamp);
      try {
        const envelope = parseWaveJobEnvelope(record.body);
        kind = envelope.kind;
        await registry.handlerFor(kind)(envelope.job);
        emitWaveJobMetrics(kind, 'processed', queueAgeMs);
      } catch (error) {
        emitWaveJobMetrics(kind, 'failed', queueAgeMs);
        try {
          logger.error({
            code: 'WAVE_FANOUT_JOB_FAILED',
            kind,
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
