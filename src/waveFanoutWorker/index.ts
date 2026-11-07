import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { prepEnvironment } from '@/env';
import * as dbApi from '@/db-api';
import { initRedis } from '@/redis';
import { Logger } from '@/logging';
import * as sentryContext from '@/sentry.context';
import { API_REDIS_FAIL_FAST_OPTIONS } from '@/api/app-initialization';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { dropCreationService } from '@/api/drops/drop-creation.api.service';
import {
  processWaveFanoutBatch,
  registerWaveJobHandler
} from '@/ws-delivery/wave-fanout-worker';
import {
  asDropCreatedEffectsJob,
  asDropFramesJob
} from '@/ws-delivery/wave-fanout-job';

registerWaveJobHandler('drop_frames', (job) =>
  wsListenersNotifier.deliverQueuedDropFrames(asDropFramesJob(job))
);
registerWaveJobHandler('drop_created_effects', (job) =>
  dropCreationService.runDropCreatedEffects(asDropCreatedEffectsJob(job), {})
);

const logger = Logger.get('WAVE_FANOUT_WORKER');

let initialized: Promise<void> | null = null;

/**
 * Secrets, MySQL pools and Redis are set up once per container and kept
 * warm across invocations, as the API does, so a queued chunk pays no
 * connection setup on the delivery path.
 */
async function initialize(): Promise<void> {
  await prepEnvironment();
  await dbApi.connect();
  await initRedis({ failFast: API_REDIS_FAIL_FAST_OPTIONS });
}

const consume = async (
  event: SQSEvent,
  _context: Context
): Promise<SQSBatchResponse> => {
  initialized ??= initialize().catch((error: unknown) => {
    initialized = null;
    throw error;
  });
  await initialized;
  logger.info(`[RECORDS ${event.Records.length}]`);
  return processWaveFanoutBatch(event);
};

export const handler = sentryContext.wrapLambdaHandler(consume);
