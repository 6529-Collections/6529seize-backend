import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { releaseNoteGenerationService } from '@/release-notes/release-note-generation.service';
import {
  RELEASE_NOTE_DEPLOYED_AT_PATTERN,
  ReleaseNoteGenerationRequest,
  ReleaseNoteRunReference
} from '@/release-notes/release-note-generation-queue';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

const logger = Logger.get('RELEASE_NOTES_GENERATION_LOOP');
const RELEASE_NOTE_DEDUPE_TTL_SECONDS = 90 * 24 * 60 * 60;
const RELEASE_NOTE_PROCESSING_TTL_SECONDS = 20 * 60;
const RELEASE_GROUP_TTL_SECONDS = RELEASE_NOTE_DEDUPE_TTL_SECONDS;
type ReleaseNotesRedis = NonNullable<ReturnType<typeof getRedisClient>>;

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

function requireTimestamp(
  payload: Record<string, unknown>,
  field: keyof ReleaseNoteGenerationRequest
): string {
  const value = requireString(payload, field);
  if (
    !RELEASE_NOTE_DEPLOYED_AT_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new Error(
      `Invalid release note message: ${String(field)} must be a full ISO timestamp`
    );
  }
  return value;
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
    prompt_path: requireString(payload, 'prompt_path'),
    release_group_id: requireString(payload, 'release_group_id'),
    release_group_services: parseServices(payload.release_group_services),
    deployed_at: requireTimestamp(payload, 'deployed_at')
  };
}

function parseServices(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
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

function sanitizeRedisKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function buildDedupeKey(request: ReleaseNoteGenerationRequest): string {
  const repo = sanitizeRedisKeyPart(request.repo);
  const group = sanitizeRedisKeyPart(request.release_group_id);
  const sha = sanitizeRedisKeyPart(request.sha);
  return `release-note:${repo}:${group}:${sha}`;
}

function buildReleaseGroupKey(request: ReleaseNoteGenerationRequest): string {
  const repo = sanitizeRedisKeyPart(request.repo);
  const group = sanitizeRedisKeyPart(request.release_group_id);
  const sha = sanitizeRedisKeyPart(request.sha);
  return `release-note-group:${repo}:${group}:${sha}`;
}

function buildRunReference(
  request: ReleaseNoteGenerationRequest,
  service: string
): ReleaseNoteRunReference {
  return {
    service,
    run_id: request.run_id,
    run_number: request.run_number,
    run_url: request.run_url
  };
}

function parseRunReference(
  value: string,
  expectedService: string
): ReleaseNoteRunReference {
  const parsed = JSON.parse(value) as Partial<ReleaseNoteRunReference>;
  if (
    parsed.service !== expectedService ||
    typeof parsed.run_id !== 'string' ||
    !parsed.run_id.trim() ||
    typeof parsed.run_url !== 'string' ||
    !parsed.run_url.trim() ||
    (parsed.run_number !== undefined &&
      parsed.run_number !== null &&
      typeof parsed.run_number !== 'string')
  ) {
    throw new Error(
      `Invalid release run metadata for service ${expectedService}`
    );
  }
  return {
    service: expectedService,
    run_id: parsed.run_id.trim(),
    run_number: parsed.run_number?.trim() || null,
    run_url: parsed.run_url.trim()
  };
}

export async function isReleaseGroupComplete(
  request: ReleaseNoteGenerationRequest,
  redis: ReleaseNotesRedis
): Promise<boolean> {
  if (request.release_group_services.length === 1) {
    return true;
  }
  const service = request.service?.trim();
  if (!service || !request.release_group_services.includes(service)) {
    throw new Error(
      `Release group ${request.release_group_id} received unexpected service ${service ?? 'missing'}`
    );
  }

  const groupKey = buildReleaseGroupKey(request);
  const completedKey = `${groupKey}:completed`;
  const runKey = `${groupKey}:run:${service}`;
  // The first successful notification owns the service run link. Redeliveries
  // and re-runs for the same release cannot rewrite already-recorded metadata.
  await redis.set(runKey, JSON.stringify(buildRunReference(request, service)), {
    NX: true,
    EX: RELEASE_GROUP_TTL_SECONDS
  });
  await redis.sAdd(completedKey, service);
  await redis.expire(completedKey, RELEASE_GROUP_TTL_SECONDS);
  const completedServices = new Set(await redis.sMembers(completedKey));
  const isComplete = request.release_group_services.every((expectedService) =>
    completedServices.has(expectedService)
  );
  if (!isComplete) {
    logger.warn(
      `Release group ${request.release_group_id} is incomplete and will not publish until these services succeed: ${request.release_group_services.filter((expectedService) => !completedServices.has(expectedService)).join(', ')}`
    );
  }
  return isComplete;
}

async function getReleaseGroupRuns(
  request: ReleaseNoteGenerationRequest,
  redis: ReleaseNotesRedis
): Promise<ReleaseNoteRunReference[]> {
  if (request.release_group_services.length === 1) {
    const service =
      request.service?.trim() || request.release_group_services[0];
    return [buildRunReference(request, service)];
  }

  const groupKey = buildReleaseGroupKey(request);
  return Promise.all(
    request.release_group_services.map(async (service) => {
      const stored = await redis.get(`${groupKey}:run:${service}`);
      if (!stored) {
        throw new Error(
          `Missing release run metadata for service ${service} in group ${request.release_group_id}`
        );
      }
      return parseRunReference(stored, service);
    })
  );
}

export async function processRequest(
  request: ReleaseNoteGenerationRequest,
  dependencies?: {
    readonly redis?: ReleaseNotesRedis | null;
    readonly generateAndPost?: typeof releaseNoteGenerationService.generateAndPost;
  }
) {
  const redis =
    dependencies && Object.prototype.hasOwnProperty.call(dependencies, 'redis')
      ? dependencies.redis
      : getRedisClient();
  if (!redis) {
    throw new Error(
      `Redis is required to deduplicate release ${request.release_group_id}`
    );
  }
  const dedupeKey = buildDedupeKey(request);
  const processingKey = `${dedupeKey}:processing`;
  const alreadyProcessed = await redis.get(dedupeKey);
  if (alreadyProcessed) {
    logger.info(`Skipping duplicate release note ${dedupeKey}`);
    return;
  }
  if (!(await isReleaseGroupComplete(request, redis))) {
    return;
  }
  const releaseGroupRuns = await getReleaseGroupRuns(request, redis);
  const lockAcquired =
    (await redis.set(processingKey, '1', {
      NX: true,
      EX: RELEASE_NOTE_PROCESSING_TTL_SECONDS
    })) !== null;
  if (!lockAcquired) {
    logger.info(`Release note ${dedupeKey} is already processing`);
    return;
  }

  try {
    const generateAndPost =
      dependencies?.generateAndPost ??
      releaseNoteGenerationService.generateAndPost.bind(
        releaseNoteGenerationService
      );
    await generateAndPost(
      { ...request, release_group_runs: releaseGroupRuns },
      {}
    );
    await redis.set(dedupeKey, '1', {
      EX: RELEASE_NOTE_DEDUPE_TTL_SECONDS
    });
  } finally {
    await redis.del(processingKey);
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
