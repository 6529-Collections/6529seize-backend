import * as sentryContext from '@/sentry.context';
import type { Handler } from 'aws-lambda';
import { DropEntity } from '@/entities/IDrop';
import { WaveDropMetricsRefreshRequestEntity } from '@/entities/IWaveDropMetricsRefreshRequest';
import { WaveDropperMetricEntity } from '@/entities/IWaveDropperMetric';
import { WaveMetricEntity } from '@/entities/IWaveMetric';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { sqs } from '@/sqs';
import { Timer } from '@/time';
import {
  WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME,
  waveDropMetricsRefreshService
} from '@/drops/wave-drop-metrics-refresh.service';
import { randomUUID } from 'crypto';

const logger = Logger.get('WAVE_DROP_METRICS_REFRESH_LOOP');
const DEFAULT_MAX_BATCHES_PER_INVOCATION = 10;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

interface WaveDropMetricsRefreshMessage {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  return parsePositiveIntString(raw, name);
}

function parsePositiveIntString(value: string, name: string): number {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`[${name}] must be a safe positive integer`);
  }
  return parsed;
}

function parsePositiveIntValue(
  value: unknown,
  name: string
): number | undefined {
  if (typeof value === 'undefined' || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`[${name}] must be a positive integer`);
    }
    return value;
  }
  const raw = String(value).trim();
  if (!raw) {
    return undefined;
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  return parsePositiveIntString(raw, name);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function parseMessageBody(body: string): WaveDropMetricsRefreshMessage {
  const parsed = parseJsonObject(body);
  const snsMessage =
    typeof parsed.Message === 'string'
      ? parseJsonObject(parsed.Message)
      : parsed;
  return {
    batchSize: parsePositiveIntValue(snsMessage.batchSize, 'batchSize'),
    maxBatches: parsePositiveIntValue(snsMessage.maxBatches, 'maxBatches')
  };
}

function getMessages(event: unknown): WaveDropMetricsRefreshMessage[] {
  if (
    event &&
    typeof event === 'object' &&
    'Records' in event &&
    Array.isArray((event as { Records?: unknown }).Records)
  ) {
    return (event as { Records: { body?: unknown }[] }).Records.map((record) =>
      parseMessageBody(String(record.body ?? '{}'))
    );
  }
  if (!event || typeof event !== 'object') {
    return [{}];
  }
  return [
    {
      batchSize: parsePositiveIntValue(
        (event as Record<string, unknown>).batchSize,
        'batchSize'
      ),
      maxBatches: parsePositiveIntValue(
        (event as Record<string, unknown>).maxBatches,
        'maxBatches'
      )
    }
  ];
}

function resolveRefreshOptions(message: WaveDropMetricsRefreshMessage) {
  return {
    batchSize:
      message.batchSize ??
      parsePositiveIntEnv('WAVE_DROP_METRICS_REFRESH_BATCH_SIZE'),
    maxBatches:
      message.maxBatches ??
      parsePositiveIntEnv('WAVE_DROP_METRICS_REFRESH_MAX_BATCHES') ??
      DEFAULT_MAX_BATCHES_PER_INVOCATION
  };
}

async function enqueueDirtyRefreshContinuation({
  batchSize,
  maxBatches
}: {
  batchSize?: number;
  maxBatches: number;
}) {
  await sqs.sendToQueueName({
    queueName: WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME,
    messageGroupId: WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID,
    message: {
      mode: 'DIRTY',
      ...(batchSize ? { batchSize } : {}),
      maxBatches,
      requestedAt: Date.now(),
      nonce: randomUUID()
    }
  });
}

const waveDropMetricsRefreshHandler: Handler = async (event) => {
  await doInDbContext(
    async () => {
      for (const message of getMessages(event)) {
        const timer = new Timer('WAVE_DROP_METRICS_REFRESH_LOOP');
        try {
          const options = resolveRefreshOptions(message);
          const result =
            await waveDropMetricsRefreshService.refreshDirtyWaveDropMetrics(
              options,
              {
                timer
              }
            );
          logger.info(
            `Refreshed dirty wave drop metrics ${JSON.stringify(result)}`
          );
          if (result.hasMore) {
            // Continuations reduce backlog latency; reservedConcurrency: 1 and
            // the durable dirty table provide the backpressure boundary.
            await enqueueDirtyRefreshContinuation({
              batchSize: options.batchSize,
              maxBatches: options.maxBatches
            });
            logger.info(`Queued dirty wave drop metrics refresh continuation`);
          }
        } finally {
          logger.info(`Finished executing ${timer.getReport()}`);
        }
      }
    },
    {
      logger,
      entities: [
        DropEntity,
        WaveDropperMetricEntity,
        WaveMetricEntity,
        WaveDropMetricsRefreshRequestEntity
      ]
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(
  waveDropMetricsRefreshHandler
);
