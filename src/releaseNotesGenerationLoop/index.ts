import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { releaseNoteGenerationService } from '@/release-notes/release-note-generation.service';
import { ReleaseNoteGenerationRequest } from '@/release-notes/release-note-generation-queue';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('RELEASE_NOTES_GENERATION_LOOP');
const RELEASE_NOTE_DEDUPE_TTL_SECONDS = 90 * 24 * 60 * 60;
const RELEASE_NOTE_PROCESSING_TTL_SECONDS = 360;
const RELEASE_GROUP_TTL_SECONDS = 24 * 60 * 60;

function requireString(
  payload: Record<string, unknown>,
  field: keyof ReleaseNoteGenerationRequest
): string {
  const value = payload[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Invalid release note message: ${String(field)} is required`
    );
  }
  return value.trim();
}

export function parseReleaseNoteMessage(
  body: string
): ReleaseNoteGenerationRequest {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid release note message payload');
  }
  const payload = parsed as Record<string, unknown>;
  const optionalString = (field: keyof ReleaseNoteGenerationRequest) => {
    const value = payload[field];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };

  return {
    repo: requireString(payload, 'repo'),
    workflow: requireString(payload, 'workflow'),
    run_id: requireString(payload, 'run_id'),
    run_number: optionalString('run_number'),
    run_url: requireString(payload, 'run_url'),
    sha: requireString(payload, 'sha'),
    branch: optionalString('branch'),
    environment: requireString(payload, 'environment'),
    service: optionalString('service'),
    prompt: requireString(payload, 'prompt'),
    release_group_id: requireString(payload, 'release_group_id'),
    release_group_services: parseServices(payload.release_group_services),
    deployed_at: requireString(payload, 'deployed_at')
  };
}

function parseServices(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      'Invalid release note message: release_group_services is required'
    );
  }
  const services = value
    .filter((service): service is string => typeof service === 'string')
    .map((service) => service.trim())
    .filter(Boolean);
  if (!services.length) {
    throw new Error(
      'Invalid release note message: release_group_services is required'
    );
  }
  return Array.from(new Set(services)).sort((a, b) => a.localeCompare(b));
}

function buildDedupeKey(request: ReleaseNoteGenerationRequest): string {
  const repo = request.repo.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const group = request.release_group_id.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `release-note:${repo}:${group}:${request.sha}`;
}

async function isReleaseGroupComplete(
  request: ReleaseNoteGenerationRequest
): Promise<boolean> {
  if (request.release_group_services.length === 1) {
    return true;
  }
  const redis = getRedisClient();
  if (!redis) {
    throw new Error(
      `Redis is required to coordinate grouped release ${request.release_group_id}`
    );
  }
  const service = request.service?.trim();
  if (!service || !request.release_group_services.includes(service)) {
    throw new Error(
      `Release group ${request.release_group_id} received unexpected service ${service ?? 'missing'}`
    );
  }

  const groupKey = `release-note-group:${request.release_group_id}:completed`;
  await redis.sAdd(groupKey, service);
  await redis.expire(groupKey, RELEASE_GROUP_TTL_SECONDS);
  const completedServices = new Set(await redis.sMembers(groupKey));
  const isComplete = request.release_group_services.every((expectedService) =>
    completedServices.has(expectedService)
  );
  if (!isComplete) {
    logger.info(
      `Release group ${request.release_group_id} is waiting for ${request.release_group_services.filter((expectedService) => !completedServices.has(expectedService)).join(', ')}`
    );
  }
  return isComplete;
}

async function processRequest(request: ReleaseNoteGenerationRequest) {
  if (!(await isReleaseGroupComplete(request))) {
    return;
  }
  const redis = getRedisClient();
  const dedupeKey = buildDedupeKey(request);
  const processingKey = `${dedupeKey}:processing`;
  let lockAcquired = false;

  if (redis) {
    const alreadyProcessed = await redis.get(dedupeKey);
    if (alreadyProcessed) {
      logger.info(`Skipping duplicate release note ${dedupeKey}`);
      return;
    }
    lockAcquired =
      (await redis.set(processingKey, '1', {
        NX: true,
        EX: RELEASE_NOTE_PROCESSING_TTL_SECONDS
      })) !== null;
    if (!lockAcquired) {
      logger.info(`Release note ${dedupeKey} is already processing`);
      return;
    }
  }

  try {
    await releaseNoteGenerationService.generateAndPost(request, {});
    if (redis) {
      await redis.set(dedupeKey, '1', {
        EX: RELEASE_NOTE_DEDUPE_TTL_SECONDS
      });
    }
  } finally {
    if (redis && lockAcquired) {
      await redis.del(processingKey);
    }
  }
}

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const request = parseReleaseNoteMessage(record.body);
        logger.info(
          `Generating release notes for ${request.repo} run ${request.run_id}`
        );
        await processRequest(request);
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
