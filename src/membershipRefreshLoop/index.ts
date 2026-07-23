import * as sentryContext from '../sentry.context';
import type { Handler } from 'aws-lambda';
import { MembershipMaterializationStateEntity } from '../entities/IMembershipMaterializationState';
import { MembershipRefreshRequestEntity } from '../entities/IMembershipRefreshRequest';
import { MembershipWatermarkEntity } from '../entities/IMembershipWatermark';
import { UserGroupMemberEntity } from '../entities/IUserGroupMember';
import { Logger } from '../logging';
import {
  membershipMaterializationService,
  RefreshAllMembershipsOptions
} from '../membership/membership-materialization.service';
import {
  MEMBERSHIP_DIRTY_REFRESH_MESSAGE_GROUP_ID,
  MEMBERSHIP_DIRTY_REFRESH_QUEUE_NAME,
  MEMBERSHIP_FULL_REFRESH_QUEUE_NAME
} from '../membership/membership.constants';
import { doInDbContext } from '../secrets';
import { sqs } from '../sqs';
import { Timer } from '../time';
import { randomUUID } from 'node:crypto';

const logger = Logger.get('MEMBERSHIP_REFRESH_LOOP');
const DEFAULT_MAX_BATCHES_PER_INVOCATION = 5;

type MembershipRefreshMode = 'FULL' | 'DIRTY';

interface MembershipRefreshMessage {
  readonly mode?: MembershipRefreshMode;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly startAfterGroupId?: string;
  readonly asOfMillis?: number;
}

function parsePositiveInteger(
  value: unknown,
  name: string
): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[${name}] must be a positive integer`);
  }
  return parsed;
}

function parseString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function parseMode(value: unknown): MembershipRefreshMode | undefined {
  const parsed = parseString(value)?.toUpperCase();
  return parsed === 'FULL' || parsed === 'DIRTY' ? parsed : undefined;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseMessageBody(body: string): MembershipRefreshMessage {
  try {
    const parsed = parseObject(body);
    const message =
      typeof parsed.Message === 'string' ? parseObject(parsed.Message) : parsed;
    return parseMessage(message);
  } catch (error) {
    logger.warn(`Ignoring membership refresh message body`, { body, error });
    return {};
  }
}

function parseMessage(
  message: Record<string, unknown>
): MembershipRefreshMessage {
  return {
    mode: parseMode(message.mode),
    batchSize: parsePositiveInteger(message.batchSize, 'batchSize'),
    maxBatches: parsePositiveInteger(message.maxBatches, 'maxBatches'),
    startAfterGroupId: parseString(message.startAfterGroupId),
    asOfMillis: parsePositiveInteger(message.asOfMillis, 'asOfMillis')
  };
}

function getMessages(event: unknown): MembershipRefreshMessage[] {
  if (
    event !== null &&
    typeof event === 'object' &&
    'Records' in event &&
    Array.isArray((event as { Records?: unknown }).Records)
  ) {
    return (event as { Records: { body?: unknown }[] }).Records.map((record) =>
      parseMessageBody(String(record.body ?? '{}'))
    );
  }
  if (event === null || typeof event !== 'object') {
    return [{}];
  }
  return [parseMessage(event as Record<string, unknown>)];
}

function resolveOptions(
  message: MembershipRefreshMessage
): RefreshAllMembershipsOptions {
  return {
    batchSize:
      message.batchSize ??
      parsePositiveInteger(
        process.env.MEMBERSHIP_REFRESH_BATCH_SIZE,
        'MEMBERSHIP_REFRESH_BATCH_SIZE'
      ),
    maxBatches:
      message.maxBatches ??
      parsePositiveInteger(
        process.env.MEMBERSHIP_REFRESH_MAX_BATCHES,
        'MEMBERSHIP_REFRESH_MAX_BATCHES'
      ) ??
      DEFAULT_MAX_BATCHES_PER_INVOCATION,
    startAfterGroupId:
      message.startAfterGroupId ??
      parseString(process.env.MEMBERSHIP_REFRESH_START_AFTER_GROUP_ID),
    asOfMillis: message.asOfMillis
  };
}

async function enqueueFullContinuation(
  options: RefreshAllMembershipsOptions & {
    readonly startAfterGroupId: string;
    readonly asOfMillis: number;
  }
): Promise<void> {
  await sqs.sendToQueueName({
    queueName: MEMBERSHIP_FULL_REFRESH_QUEUE_NAME,
    messageGroupId: 'membership-refresh-full',
    message: {
      mode: 'FULL',
      ...options
    }
  });
}

async function enqueueDirtyContinuation(
  options: RefreshAllMembershipsOptions
): Promise<void> {
  await sqs.sendToQueueName({
    queueName: MEMBERSHIP_DIRTY_REFRESH_QUEUE_NAME,
    messageGroupId: MEMBERSHIP_DIRTY_REFRESH_MESSAGE_GROUP_ID,
    message: {
      mode: 'DIRTY',
      batchSize: options.batchSize,
      maxBatches: options.maxBatches,
      requestedAt: Date.now(),
      nonce: randomUUID()
    }
  });
}

const membershipRefreshHandler: Handler = async (event) => {
  await doInDbContext(
    async () => {
      for (const message of getMessages(event)) {
        const timer = new Timer('MEMBERSHIP_REFRESH_LOOP');
        const options = resolveOptions(message);
        try {
          if (message.mode === 'DIRTY') {
            const result =
              await membershipMaterializationService.refreshDirtyMemberships(
                options,
                { timer }
              );
            logger.info(
              `Refreshed dirty membership targets ${JSON.stringify(result)}`
            );
            if (result.hasMore) {
              await enqueueDirtyContinuation(options);
            }
            continue;
          }

          const result =
            await membershipMaterializationService.refreshAllMemberships(
              options,
              { timer }
            );
          logger.info(
            `Refreshed full membership page ${JSON.stringify(result)}`
          );
          if (result.hasMore && result.lastGroupId) {
            await enqueueFullContinuation({
              ...options,
              startAfterGroupId: result.lastGroupId,
              asOfMillis: result.asOfMillis
            });
          }
        } finally {
          logger.info(`Finished executing ${timer.getReport()}`);
        }
      }
    },
    {
      logger,
      entities: [
        MembershipMaterializationStateEntity,
        MembershipRefreshRequestEntity,
        MembershipWatermarkEntity,
        UserGroupMemberEntity
      ]
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(
  membershipRefreshHandler
);
