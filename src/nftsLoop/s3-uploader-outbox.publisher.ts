import { getDataSource } from '@/db';
import {
  S3UploaderOutboxEntity,
  S3UploaderOutboxStatus
} from '@/entities/IS3UploaderOutbox';
import { Logger } from '@/logging';
import { isS3UploaderEnabledForEnvironment } from '@/s3Uploader/s3-uploader.queue';
import { S3_UPLOADER_QUEUE_NAME } from '@/s3Uploader/s3-uploader.jobs';
import { sqs } from '@/sqs';
import { Time } from '@/time';
import { inspect } from 'node:util';
import { LessThan } from 'typeorm';

const logger = Logger.get('NFTS');

const S3_OUTBOX_PUBLISH_BATCH_SIZE = 10;
const S3_OUTBOX_ERROR_MAX_LENGTH = 2048;
const S3_OUTBOX_FAILURE_ESCALATION_ATTEMPTS = 3;
const S3_OUTBOX_PUBLISHED_RETENTION_DAYS = 30;

export async function publishPendingS3UploaderOutboxJobs(mode?: string) {
  if (!isS3UploaderEnabledForEnvironment()) {
    return;
  }

  const repo = getDataSource().getRepository(S3UploaderOutboxEntity);
  const pendingCount = await getPendingOutboxCount(repo);
  if (!pendingCount) {
    await cleanupPublishedOutboxRows(repo, mode);
    return;
  }

  logInfo(mode, `📤 Publishing S3 uploader outbox [pending=${pendingCount}]`);
  const escalationIds = new Set<number>();
  const maxPendingOutboxId = await getMaxPendingOutboxId(repo);
  if (!maxPendingOutboxId) {
    await cleanupPublishedOutboxRows(repo, mode);
    return;
  }
  let lastProcessedId = 0;

  while (true) {
    const pending = await getPendingOutboxBatch(
      repo,
      lastProcessedId,
      maxPendingOutboxId
    );
    if (!pending.length) {
      break;
    }

    for (const outbox of pending) {
      await publishOutboxJob(repo, outbox, escalationIds, mode);
    }
    lastProcessedId = pending[pending.length - 1].id;
  }

  await cleanupPublishedOutboxRows(repo, mode);

  if (escalationIds.size > 0) {
    throw new Error(
      `S3 uploader outbox jobs reached failure threshold [threshold=${S3_OUTBOX_FAILURE_ESCALATION_ATTEMPTS}] [ids=${Array.from(
        escalationIds
      ).join(',')}]`
    );
  }
}

async function getPendingOutboxCount(repo: ReturnType<typeof getOutboxRepo>) {
  return repo.count({
    where: { status: S3UploaderOutboxStatus.PENDING }
  });
}

async function getMaxPendingOutboxId(repo: ReturnType<typeof getOutboxRepo>) {
  const newestPending = await repo.findOne({
    select: ['id'],
    where: { status: S3UploaderOutboxStatus.PENDING },
    order: { id: 'DESC' }
  });
  return newestPending?.id ?? null;
}

async function getPendingOutboxBatch(
  repo: ReturnType<typeof getOutboxRepo>,
  lastProcessedId: number,
  maxPendingOutboxId: number
) {
  if (lastProcessedId >= maxPendingOutboxId) {
    return [];
  }

  return repo
    .createQueryBuilder('outbox')
    .where('outbox.status = :status', {
      status: S3UploaderOutboxStatus.PENDING
    })
    .andWhere('outbox.id > :lastProcessedId', { lastProcessedId })
    .andWhere('outbox.id <= :maxPendingOutboxId', { maxPendingOutboxId })
    .orderBy('outbox.id', 'ASC')
    .take(S3_OUTBOX_PUBLISH_BATCH_SIZE)
    .getMany();
}

function getOutboxRepo() {
  return getDataSource().getRepository(S3UploaderOutboxEntity);
}

async function publishOutboxJob(
  repo: ReturnType<typeof getOutboxRepo>,
  outbox: S3UploaderOutboxEntity,
  escalationIds: Set<number>,
  mode?: string
) {
  const attempt = outbox.attempts + 1;
  logInfo(
    mode,
    `📤 Publishing S3 uploader outbox job [id=${outbox.id}] [attempt=${attempt}]`
  );
  try {
    await sqs.sendToQueueName({
      queueName: S3_UPLOADER_QUEUE_NAME,
      message: outbox.job
    });
    await repo.update(
      { id: outbox.id },
      {
        status: S3UploaderOutboxStatus.PUBLISHED,
        published_at: Time.now().toMillis(),
        attempts: attempt,
        last_error: null
      }
    );
  } catch (error: unknown) {
    const message = formatOutboxPublishError(error);
    logError(
      mode,
      `❌ Failed publishing S3 uploader outbox job [id=${outbox.id}] [attempt=${attempt}] [error=${truncateOutboxError(
        message
      )}]`
    );
    await repo.update(
      { id: outbox.id },
      {
        attempts: attempt,
        last_error: truncateOutboxError(message)
      }
    );
    if (attempt === S3_OUTBOX_FAILURE_ESCALATION_ATTEMPTS) {
      escalationIds.add(outbox.id);
    }
    return;
  }
}

async function cleanupPublishedOutboxRows(
  repo: ReturnType<typeof getOutboxRepo>,
  mode?: string
) {
  const cutoff = Time.daysAgo(S3_OUTBOX_PUBLISHED_RETENTION_DAYS).toMillis();
  const result = await repo.delete({
    status: S3UploaderOutboxStatus.PUBLISHED,
    published_at: LessThan(cutoff)
  });
  const deletedRows = result.affected ?? 0;
  if (deletedRows > 0) {
    logInfo(
      mode,
      `🧹 Cleaned up published S3 uploader outbox rows [deleted=${deletedRows}] [olderThanDays=${S3_OUTBOX_PUBLISHED_RETENTION_DAYS}]`
    );
  }
}

function modePrefix(mode?: string) {
  return mode ? `[${mode.toUpperCase()}] ` : '';
}

function logInfo(mode: string | undefined, message: string) {
  logger.info(`${modePrefix(mode)}${message}`);
}

function logError(mode: string | undefined, message: string) {
  logger.error(`${modePrefix(mode)}${message}`);
}

function truncateOutboxError(value: string): string {
  if (value.length <= S3_OUTBOX_ERROR_MAX_LENGTH) {
    return value;
  }
  return value.slice(0, S3_OUTBOX_ERROR_MAX_LENGTH);
}

function formatOutboxPublishError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error == null) {
    return '';
  }

  try {
    const asJson = JSON.stringify(error);
    if (asJson) {
      return asJson;
    }
  } catch {
    // fall through to util.inspect
  }

  return inspect(error, { depth: 3, breakLength: 120 });
}
