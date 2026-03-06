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

const logger = Logger.get('nfts');

const S3_OUTBOX_PUBLISH_BATCH_SIZE = 10;
const S3_OUTBOX_ERROR_MAX_LENGTH = 2048;
const S3_OUTBOX_FAILURE_ESCALATION_ATTEMPTS = 3;

export async function publishPendingS3UploaderOutboxJobs() {
  if (!isS3UploaderEnabledForEnvironment()) {
    return;
  }

  const repo = getDataSource().getRepository(S3UploaderOutboxEntity);
  const pendingCount = await getPendingOutboxCount(repo);
  if (!pendingCount) {
    return;
  }

  logger.info(`📤 Publishing S3 uploader outbox [pending=${pendingCount}]`);
  const escalationIds = new Set<number>();

  while (true) {
    const pending = await getPendingOutboxBatch(repo);
    if (!pending.length) {
      break;
    }

    let batchFailures = 0;
    for (const outbox of pending) {
      if (await publishOutboxJob(repo, outbox, escalationIds)) {
        batchFailures++;
      }
    }

    if (shouldStopPublishing(batchFailures, pending.length)) {
      break;
    }
  }

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

async function getPendingOutboxBatch(repo: ReturnType<typeof getOutboxRepo>) {
  return repo.find({
    where: { status: S3UploaderOutboxStatus.PENDING },
    order: { id: 'ASC' },
    take: S3_OUTBOX_PUBLISH_BATCH_SIZE
  });
}

function getOutboxRepo() {
  return getDataSource().getRepository(S3UploaderOutboxEntity);
}

function shouldStopPublishing(batchFailures: number, batchSize: number) {
  return (
    batchFailures === batchSize || batchSize < S3_OUTBOX_PUBLISH_BATCH_SIZE
  );
}

async function publishOutboxJob(
  repo: ReturnType<typeof getOutboxRepo>,
  outbox: S3UploaderOutboxEntity,
  escalationIds: Set<number>
) {
  const attempt = outbox.attempts + 1;
  logger.info(
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
    return false;
  } catch (error: unknown) {
    const message = formatOutboxPublishError(error);
    logger.error(
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
    return true;
  }
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
