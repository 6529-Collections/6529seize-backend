import * as sentryContext from '../sentry.context';
import type { Handler } from 'aws-lambda';
import { DropEntity, DropMentionedWaveEntity } from '../entities/IDrop';
import { IdentityEntity } from '../entities/IIdentity';
import { IdentitySubscriptionEntity } from '../entities/IIdentitySubscription';
import { Rating } from '../entities/IRating';
import { WaveEntity } from '../entities/IWave';
import { WaveMetricEntity } from '../entities/IWaveMetric';
import { WaveScoreRefreshRequestEntity } from '../entities/IWaveScoreRefreshRequest';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { sqs } from '../sqs';
import { Timer } from '../time';
import {
  WAVE_SCORE_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  WAVE_SCORE_DIRTY_REFRESH_QUEUE_NAME,
  waveScoreService
} from '../api-serverless/src/waves/wave-score.service';
import { randomUUID } from 'crypto';
import { FullRefreshHealth, observeDirtyRefreshBacklog } from './loop-health';

const logger = Logger.get('WAVE_SCORE_REFRESH_LOOP');
const FULL_REFRESH_QUEUE_NAME = 'wave-score-refresh-start.fifo';
const DEFAULT_MAX_BATCHES_PER_INVOCATION = 10;
type WaveScoreRefreshMode = 'FULL' | 'DIRTY';

interface WaveScoreRefreshMessage {
  readonly mode?: WaveScoreRefreshMode;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly startAfterWaveId?: string;
  readonly healthStartedAt?: number;
  readonly automaticRetry?: boolean;
}

function healthStartedAt(value: unknown): number | undefined {
  const seconds = Math.floor(Number(value) / 1000);
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds <= Math.floor(Date.now() / 1000)
    ? seconds
    : undefined;
}

function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  return value;
}

function parseStringEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function parsePositiveIntValue(
  value: unknown,
  name: string
): number | undefined {
  if (typeof value === 'undefined' || value === null || value === '') {
    return undefined;
  }
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  return parsed;
}

function parseStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function parseModeValue(value: unknown): WaveScoreRefreshMode | undefined {
  const parsed = parseStringValue(value)?.toUpperCase();
  if (parsed === 'FULL' || parsed === 'DIRTY') {
    return parsed;
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function parseMessageBody(body: string): WaveScoreRefreshMessage {
  try {
    const parsed = parseJsonObject(body);
    const snsMessage =
      typeof parsed.Message === 'string'
        ? parseJsonObject(parsed.Message)
        : parsed;
    return {
      mode: parseModeValue(snsMessage.mode),
      batchSize: parsePositiveIntValue(snsMessage.batchSize, 'batchSize'),
      maxBatches: parsePositiveIntValue(snsMessage.maxBatches, 'maxBatches'),
      startAfterWaveId: parseStringValue(snsMessage.startAfterWaveId)
    };
  } catch (error) {
    logger.warn(`Ignoring wave score refresh message body ${body}`, { error });
    return {};
  }
}

function getMessages(event: unknown): WaveScoreRefreshMessage[] {
  if (
    event &&
    typeof event === 'object' &&
    'Records' in event &&
    Array.isArray((event as { Records?: unknown }).Records)
  ) {
    return (
      event as {
        Records: {
          body?: unknown;
          eventSource?: string;
          attributes?: { SentTimestamp?: string };
          messageAttributes?: {
            LoopHealthStartedAt?: { stringValue?: string };
          };
        }[];
      }
    ).Records.map((record) => {
      const message = parseMessageBody(String(record.body ?? '{}'));
      return {
        ...message,
        automaticRetry: record.eventSource === 'aws:sqs',
        healthStartedAt:
          healthStartedAt(
            record.messageAttributes?.LoopHealthStartedAt?.stringValue
          ) ?? healthStartedAt(record.attributes?.SentTimestamp)
      };
    });
  }
  if (!event || typeof event !== 'object') {
    return [{}];
  }
  return [
    {
      mode: parseModeValue((event as Record<string, unknown>).mode),
      batchSize: parsePositiveIntValue(
        (event as Record<string, unknown>).batchSize,
        'batchSize'
      ),
      maxBatches: parsePositiveIntValue(
        (event as Record<string, unknown>).maxBatches,
        'maxBatches'
      ),
      startAfterWaveId: parseStringValue(
        (event as Record<string, unknown>).startAfterWaveId
      )
    }
  ];
}

function resolveRefreshOptions(message: WaveScoreRefreshMessage) {
  return {
    batchSize:
      message.batchSize ?? parsePositiveIntEnv('WAVE_SCORE_REFRESH_BATCH_SIZE'),
    maxBatches:
      message.maxBatches ??
      parsePositiveIntEnv('WAVE_SCORE_REFRESH_MAX_BATCHES') ??
      DEFAULT_MAX_BATCHES_PER_INVOCATION,
    startAfterWaveId:
      message.startAfterWaveId ??
      parseStringEnv('WAVE_SCORE_REFRESH_START_AFTER_WAVE_ID')
  };
}

async function enqueueFullRefreshContinuation({
  batchSize,
  maxBatches,
  startAfterWaveId,
  startedAt
}: {
  batchSize?: number;
  maxBatches: number;
  startAfterWaveId: string;
  startedAt: number;
}) {
  await sqs.sendToQueueName({
    queueName: FULL_REFRESH_QUEUE_NAME,
    messageGroupId: 'wave-score-refresh',
    message: {
      mode: 'FULL',
      ...(batchSize ? { batchSize } : {}),
      maxBatches,
      startAfterWaveId
    },
    // FIFO content-based deduplication hashes the body, not message attributes.
    messageAttributes: {
      LoopHealthStartedAt: {
        DataType: 'Number',
        StringValue: String(startedAt * 1000)
      }
    }
  });
}

async function enqueueDirtyRefreshContinuation({
  batchSize,
  maxBatches
}: {
  batchSize?: number;
  maxBatches: number;
}) {
  await sqs.sendToQueueName({
    queueName: WAVE_SCORE_DIRTY_REFRESH_QUEUE_NAME,
    messageGroupId: WAVE_SCORE_DIRTY_REFRESH_MESSAGE_GROUP_ID,
    message: {
      mode: 'DIRTY',
      ...(batchSize ? { batchSize } : {}),
      maxBatches,
      requestedAt: Date.now(),
      nonce: randomUUID()
    }
  });
}

async function refreshFullScores(
  message: WaveScoreRefreshMessage,
  options: ReturnType<typeof resolveRefreshOptions>,
  timer: Timer
): Promise<void> {
  const health = new FullRefreshHealth(
    message.healthStartedAt ?? Math.floor(Date.now() / 1000),
    message.automaticRetry === true
  );
  try {
    const result = await waveScoreService.refreshAllWaveScores(options, {
      timer
    });
    health.committed(result.waves);
    logger.info(`Refreshed wave scores ${JSON.stringify(result)}`);
    if (result.hasMore && result.lastWaveId) {
      await enqueueFullRefreshContinuation({
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
        startAfterWaveId: result.lastWaveId,
        startedAt: health.startedAt
      });
      health.continued();
      logger.info(
        `Queued wave score refresh continuation after ${result.lastWaveId}`
      );
    } else if (!result.hasMore) health.completed();
  } catch (error) {
    health.failed();
    throw error;
  }
}

const waveScoreRefreshHandler: Handler = async (event, context) => {
  const observeDirty = async () => {
    if (
      !context?.getRemainingTimeInMillis ||
      context.getRemainingTimeInMillis() > 5000
    )
      await observeDirtyRefreshBacklog();
  };
  await doInDbContext(
    async () => {
      for (const message of getMessages(event)) {
        const timer = new Timer('WAVE_SCORE_REFRESH_LOOP');
        try {
          const options = resolveRefreshOptions(message);
          await observeDirty();
          if (message.mode === 'DIRTY') {
            const result = await waveScoreService.refreshDirtyWaveScores(
              options,
              {
                timer
              }
            );
            logger.info(
              `Refreshed dirty wave scores ${JSON.stringify(result)}`
            );
            if (result.hasMore) {
              await enqueueDirtyRefreshContinuation({
                batchSize: options.batchSize,
                maxBatches: options.maxBatches
              });
              logger.info(`Queued dirty wave score refresh continuation`);
            }
          } else {
            await refreshFullScores(message, options, timer);
          }
        } finally {
          await observeDirty();
          logger.info(`Finished executing ${timer.getReport()}`);
        }
      }
    },
    {
      logger,
      entities: [
        DropEntity,
        DropMentionedWaveEntity,
        IdentityEntity,
        IdentitySubscriptionEntity,
        Rating,
        WaveEntity,
        WaveMetricEntity,
        WaveScoreRefreshRequestEntity
      ]
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(waveScoreRefreshHandler);
