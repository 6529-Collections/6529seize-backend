import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import {
  buildReleaseNotePublicationId,
  isDesktopRelease,
  isFrontendRelease,
  ReleaseNoteGenerationOptions,
  releaseNoteGenerationService
} from '@/release-notes/release-note-generation.service';
import {
  PreparedReleaseNotePublication,
  releaseNotePublicationService,
  ReleaseNotePublicationService
} from '@/release-notes/release-note-publication.service';
import {
  RELEASE_NOTE_DEPLOYED_AT_PATTERN,
  ReleaseNoteGenerationRequest,
  ReleaseNoteRunReference
} from '@/release-notes/release-note-generation-queue';
import {
  isNonRetryableReleaseNoteError,
  NonRetryableReleaseNoteError,
  UntrustedReleaseNoteMetadataError
} from '@/release-notes/release-note-errors';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import {
  CiPipelineAlertRequest,
  ciPipelineAlertService
} from '@/api-serverless/src/ci-pipeline-alerts/ci-pipeline-alert.service';
import type { SQSHandler } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const logger = Logger.get('RELEASE_NOTES_GENERATION_LOOP');
const RELEASE_NOTE_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const RELEASE_NOTE_PROCESSING_TTL_SECONDS = 4 * 60;
const RELEASE_NOTE_MINIMUM_PART_TIME_MS = 45_000;
const RELEASE_GROUP_TTL_SECONDS = RELEASE_NOTE_DEDUPE_TTL_SECONDS;
const DESKTOP_RELEASE_NOTE_FINAL_ATTEMPT = 4;
const RELEASE_NOTE_FINAL_ATTEMPT = 5;
type ReleaseNotesRedis = NonNullable<ReturnType<typeof getRedisClient>>;

type ReleaseNotePublicationState = Pick<
  ReleaseNotePublicationService,
  'prepare' | 'recordPlan' | 'recordPart' | 'complete'
>;

interface ProcessRequestDependencies {
  readonly redis?: ReleaseNotesRedis | null;
  readonly generateAndPost?: typeof releaseNoteGenerationService.generateAndPost;
  readonly publicationState?: ReleaseNotePublicationState;
  readonly getRemainingTimeInMillis?: () => number;
}

class RetryableReleaseNoteError extends Error {
  public readonly cause: unknown;

  public constructor(error: unknown) {
    super(getErrorMessage(error));
    this.name = 'RetryableReleaseNoteError';
    this.cause = error;
    Object.setPrototypeOf(this, RetryableReleaseNoteError.prototype);
  }
}

export function shouldCaptureReleaseNoteError(error: unknown): boolean {
  return !(error instanceof RetryableReleaseNoteError);
}

export function prepareReleaseNoteErrorForRetry(
  error: unknown,
  receiveCount: number
): unknown {
  if (isNonRetryableReleaseNoteError(error)) {
    return error;
  }
  return receiveCount < RELEASE_NOTE_FINAL_ATTEMPT
    ? new RetryableReleaseNoteError(error)
    : error;
}

export function shouldRetryReleaseNoteError(error: unknown): boolean {
  return !isNonRetryableReleaseNoteError(error);
}

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

function parsePullRequestNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(
      'Invalid release note message: pull_request_number must be a positive integer'
    );
  }
  return Number(value);
}

function parsePublishReleaseNote(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(
      'Invalid release note message: publish_release_note must be a boolean'
    );
  }
  return value;
}

function parseContributorGithubLogins(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      'Invalid release note message: contributor_github_logins must be an array'
    );
  }
  const contributors: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new TypeError(
        'Invalid release note message: contributor_github_logins must contain non-empty strings'
      );
    }
    const login = candidate.trim();
    if (
      !contributors.some(
        (contributor) => contributor.toLowerCase() === login.toLowerCase()
      )
    ) {
      contributors.push(login);
    }
  }
  return contributors;
}

function parseReleaseNoteMessagePayload(
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
  const triggeredByGithubLogin = optionalString('triggered_by_github_login');
  const releaseVersion = optionalString('release_version');
  const frontendSha = optionalString('frontend_sha');

  const request: ReleaseNoteGenerationRequest = {
    repo: requireString(payload, 'repo'),
    workflow: requireString(payload, 'workflow'),
    run_id: requireString(payload, 'run_id'),
    run_number: optionalString('run_number'),
    run_url: requireString(payload, 'run_url'),
    ...(triggeredByGithubLogin
      ? { triggered_by_github_login: triggeredByGithubLogin }
      : {}),
    sha: requireString(payload, 'sha'),
    branch: optionalString('branch'),
    environment: requireString(payload, 'environment'),
    service: optionalString('service'),
    prompt_path: requireString(payload, 'prompt_path'),
    release_group_id: requireString(payload, 'release_group_id'),
    release_group_services: parseServices(payload.release_group_services),
    pull_request_number: parsePullRequestNumber(payload.pull_request_number),
    contributor_github_logins: parseContributorGithubLogins(
      payload.contributor_github_logins
    ),
    publish_release_note: parsePublishReleaseNote(payload.publish_release_note),
    ...(releaseVersion ? { release_version: releaseVersion } : {}),
    ...(frontendSha ? { frontend_sha: frontendSha } : {}),
    deployed_at: requireTimestamp(payload, 'deployed_at')
  };
  const repoName = request.repo.split('/').pop()?.toLowerCase();
  const hasDesktopFields = Boolean(
    request.release_version || request.frontend_sha
  );
  if (
    (repoName === '6529-core' || hasDesktopFields) &&
    (repoName !== '6529-core' ||
      !request.release_version ||
      !/^\d+\.\d+\.\d+$/.test(request.release_version) ||
      !request.frontend_sha ||
      !/^[a-f0-9]{40}$/.test(request.frontend_sha))
  ) {
    throw new Error(
      'Invalid release note message: release_version and frontend_sha are required for 6529-core'
    );
  }
  return request;
}

export function parseReleaseNoteMessage(
  body: string
): ReleaseNoteGenerationRequest {
  try {
    return parseReleaseNoteMessagePayload(body);
  } catch (error) {
    if (isNonRetryableReleaseNoteError(error)) {
      throw error;
    }
    throw new NonRetryableReleaseNoteError(getErrorMessage(error), error);
  }
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
  if (request.pull_request_number) {
    return `release-note:${repo}:pr-${request.pull_request_number}`;
  }
  const group = sanitizeRedisKeyPart(request.release_group_id);
  const sha = sanitizeRedisKeyPart(request.sha);
  return `release-note:${repo}:${group}:${sha}`;
}

function buildReleaseGroupKey(request: ReleaseNoteGenerationRequest): string {
  const repo = sanitizeRedisKeyPart(request.repo);
  if (request.pull_request_number) {
    return `release-note-group:${repo}:pr-${request.pull_request_number}`;
  }
  const group = sanitizeRedisKeyPart(request.release_group_id);
  const sha = sanitizeRedisKeyPart(request.sha);
  return `release-note-group:${repo}:${group}:${sha}`;
}

async function canonicalReleaseGroupServices(
  request: ReleaseNoteGenerationRequest,
  redis: ReleaseNotesRedis
): Promise<string[]> {
  const expectedKey = `${buildReleaseGroupKey(request)}:expected`;
  const proposed = JSON.stringify(request.release_group_services);
  await redis.set(expectedKey, proposed, {
    NX: true,
    EX: RELEASE_GROUP_TTL_SECONDS
  });
  const stored = await redis.get(expectedKey);
  if (!stored) {
    throw new Error(
      `Release group ${request.release_group_id} has no canonical service set`
    );
  }
  let expected: unknown;
  try {
    expected = JSON.parse(stored) as unknown;
  } catch {
    throw new Error(
      `Release group ${request.release_group_id} has invalid canonical services`
    );
  }
  if (
    !Array.isArray(expected) ||
    expected.length === 0 ||
    expected.some((service) => typeof service !== 'string')
  ) {
    throw new Error(
      `Release group ${request.release_group_id} has invalid canonical services`
    );
  }
  const canonical = [...expected].sort((left, right) =>
    left.localeCompare(right)
  );
  if (
    new Set(canonical).size !== canonical.length ||
    JSON.stringify(canonical) !== proposed
  ) {
    throw new Error(
      `Release group ${request.release_group_id} changed its canonical service set`
    );
  }
  return canonical;
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
  const service = request.service?.trim();
  const expectedServices = await canonicalReleaseGroupServices(request, redis);
  if (!service || !expectedServices.includes(service)) {
    throw new Error(
      `Release group ${request.release_group_id} received unexpected service ${service ?? 'missing'}`
    );
  }
  if (request.pull_request_number) {
    const groupKey = buildReleaseGroupKey(request);
    await redis.set(
      `${groupKey}:run:${service}`,
      JSON.stringify(buildRunReference(request, service)),
      { EX: RELEASE_GROUP_TTL_SECONDS }
    );
    await redis.sAdd(`${groupKey}:services`, service);
    await redis.expire(`${groupKey}:services`, RELEASE_GROUP_TTL_SECONDS);
    const completedKey = `${groupKey}:completed`;
    await redis.sAdd(completedKey, service);
    await redis.expire(completedKey, RELEASE_GROUP_TTL_SECONDS);
    const publishRequestedKey = `${groupKey}:publish-requested`;
    if (request.publish_release_note === true) {
      await redis.set(publishRequestedKey, '1', {
        EX: RELEASE_GROUP_TTL_SECONDS
      });
    }
    if (!(await redis.get(publishRequestedKey))) return false;
    const completedServices = new Set(await redis.sMembers(completedKey));
    const complete =
      completedServices.size === expectedServices.length &&
      expectedServices.every((expectedService) =>
        completedServices.has(expectedService)
      );
    if (!complete) {
      logger.warn(
        `Release group ${request.release_group_id} is incomplete and will not publish until these services succeed: ${expectedServices.filter((expectedService) => !completedServices.has(expectedService)).join(', ')}`
      );
    }
    return complete;
  }

  if (expectedServices.length === 1) {
    return true;
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
  const isComplete =
    completedServices.size === expectedServices.length &&
    expectedServices.every((expectedService) =>
      completedServices.has(expectedService)
    );
  if (!isComplete) {
    logger.warn(
      `Release group ${request.release_group_id} is incomplete and will not publish until these services succeed: ${expectedServices.filter((expectedService) => !completedServices.has(expectedService)).join(', ')}`
    );
  }
  return isComplete;
}

async function getReleaseGroupState(
  request: ReleaseNoteGenerationRequest,
  redis: ReleaseNotesRedis
): Promise<{
  readonly services: string[];
  readonly runs: ReleaseNoteRunReference[];
}> {
  const expectedServices = await canonicalReleaseGroupServices(request, redis);
  if (!request.pull_request_number && expectedServices.length === 1) {
    const service = request.service?.trim() || expectedServices[0];
    return {
      services: [service],
      runs: [buildRunReference(request, service)]
    };
  }

  const groupKey = buildReleaseGroupKey(request);
  const services = expectedServices;
  const runs = await Promise.all(
    services.map(async (service) => {
      const stored = await redis.get(`${groupKey}:run:${service}`);
      if (!stored) {
        logger.warn(
          `Publishing release group ${request.release_group_id} without expired run metadata for service ${service}`
        );
        return null;
      }
      return parseRunReference(stored, service);
    })
  );
  return {
    services,
    runs: runs.filter((run): run is ReleaseNoteRunReference => run !== null)
  };
}

function resolveReleaseNotesRedis(
  dependencies?: ProcessRequestDependencies
): ReleaseNotesRedis | null {
  if (Object.prototype.hasOwnProperty.call(dependencies ?? {}, 'redis')) {
    return dependencies?.redis ?? null;
  }
  return getRedisClient();
}

async function prepareDurablePublication(
  request: ReleaseNoteGenerationRequest,
  publicationState: ReleaseNotePublicationState
): Promise<PreparedReleaseNotePublication | null> {
  if (request.pull_request_number) {
    return null;
  }
  const prepared = await publicationState.prepare(
    request,
    buildReleaseNotePublicationId(request),
    {}
  );
  if (!prepared) {
    throw new NonRetryableReleaseNoteError(
      `No previous successful production run was found for ${request.repo} run ${request.run_id}`
    );
  }
  return prepared;
}

function buildGenerationOptions({
  publication,
  publicationState,
  getRemainingTimeInMillis
}: {
  readonly publication: PreparedReleaseNotePublication | null;
  readonly publicationState: ReleaseNotePublicationState;
  readonly getRemainingTimeInMillis?: () => number;
}): ReleaseNoteGenerationOptions | undefined {
  if (!publication && !getRemainingTimeInMillis) {
    return undefined;
  }
  const assertCanStartPart = (partNumber: number, totalParts: number) => {
    const remaining = getRemainingTimeInMillis?.();
    if (
      remaining !== undefined &&
      remaining < RELEASE_NOTE_MINIMUM_PART_TIME_MS
    ) {
      throw new Error(
        `Deferring release-note part ${partNumber}/${totalParts} with ${remaining}ms remaining`
      );
    }
  };
  if (!publication) {
    return { assertCanStartPart };
  }
  return {
    previousSha: publication.previousSha,
    assertCanStartPart,
    onPlan: async (totalParts: number) => {
      await publicationState.recordPlan(
        publication.publicationId,
        totalParts,
        {}
      );
    },
    onPartCompleted: async ({ partNumber, totalParts, dropId }) => {
      if (!dropId) {
        throw new Error(
          `Release-note part ${partNumber}/${totalParts} did not return a drop id`
        );
      }
      await publicationState.recordPart(
        {
          publicationId: publication.publicationId,
          partNumber,
          totalParts,
          dropId
        },
        {}
      );
    }
  };
}

async function releaseProcessingLock(
  redis: ReleaseNotesRedis,
  processingKey: string,
  lockToken: string
): Promise<void> {
  try {
    await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      { keys: [processingKey], arguments: [lockToken] }
    );
  } catch (cleanupError) {
    logger.warn(
      `Failed to release release-note processing lock ${processingKey}: ${getErrorMessage(cleanupError)}`
    );
  }
}

export async function processRequest(
  request: ReleaseNoteGenerationRequest,
  dependencies?: ProcessRequestDependencies
) {
  const redis = resolveReleaseNotesRedis(dependencies);
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
  const releaseGroup = await getReleaseGroupState(request, redis);
  const publicationState =
    dependencies?.publicationState ?? releaseNotePublicationService;
  const lockToken = randomUUID();
  const lockAcquired =
    (await redis.set(processingKey, lockToken, {
      NX: true,
      EX: RELEASE_NOTE_PROCESSING_TTL_SECONDS
    })) !== null;
  if (!lockAcquired) {
    throw new Error(`Release note ${dedupeKey} is already processing`);
  }

  try {
    const preparedPublication = await prepareDurablePublication(
      request,
      publicationState
    );
    if (preparedPublication?.completed) {
      await redis.set(dedupeKey, '1', {
        EX: RELEASE_NOTE_DEDUPE_TTL_SECONDS
      });
      return;
    }
    const generateAndPost =
      dependencies?.generateAndPost ??
      releaseNoteGenerationService.generateAndPost.bind(
        releaseNoteGenerationService
      );
    const generationRequest = {
      ...request,
      release_group_services: releaseGroup.services,
      release_group_runs: releaseGroup.runs
    };
    const generationOptions = buildGenerationOptions({
      publication: preparedPublication,
      publicationState,
      getRemainingTimeInMillis: dependencies?.getRemainingTimeInMillis
    });
    const outcome = generationOptions
      ? await generateAndPost(generationRequest, {}, generationOptions)
      : await generateAndPost(generationRequest, {});
    if (outcome !== 'no-baseline') {
      if (preparedPublication) {
        await publicationState.complete(preparedPublication.publicationId, {});
      }
      await redis.set(dedupeKey, '1', {
        EX: RELEASE_NOTE_DEDUPE_TTL_SECONDS
      });
    }
  } finally {
    await releaseProcessingLock(redis, processingKey, lockToken);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown release-note error';
}

function getReleaseNoteSurface(request: ReleaseNoteGenerationRequest): string {
  if (isDesktopRelease(request)) return 'Desktop';
  if (isFrontendRelease(request)) return 'Frontend';
  return 'Backend';
}

export function buildReleaseNoteFailureAlert(
  request: ReleaseNoteGenerationRequest,
  error: unknown,
  receiveCount: number
): CiPipelineAlertRequest {
  const surface = getReleaseNoteSurface(request);
  const retryDescription = isNonRetryableReleaseNoteError(error)
    ? 'because the failure is not retryable'
    : `after ${Math.max(0, receiveCount - 1)} retries`;
  const desktopContext = isDesktopRelease(request)
    ? ` Frontend commit ${request.frontend_sha?.slice(0, 8) ?? 'unknown'}.`
    : '';
  const releaseContext = isDesktopRelease(request)
    ? `v${request.release_version ?? 'unknown'}`
    : surface;
  return {
    repo: request.repo,
    workflow: request.workflow,
    status: 'failure',
    title: `${surface} release note failed`,
    description: `Production ${releaseContext} release note could not be published ${retryDescription}.${desktopContext} ${getErrorMessage(error)}`,
    triggered_by_github_login: request.triggered_by_github_login,
    run_id: request.run_id,
    run_number: request.run_number,
    run_url: request.run_url,
    sha: request.sha,
    branch: request.branch,
    environment: 'prod',
    service: request.service
  };
}

async function postReleaseNoteFailure(
  request: ReleaseNoteGenerationRequest,
  error: unknown,
  receiveCount: number
): Promise<void> {
  await ciPipelineAlertService.postAlert(
    buildReleaseNoteFailureAlert(request, error, receiveCount),
    {}
  );
}

export async function processRequestWithRetryPolicy(
  request: ReleaseNoteGenerationRequest,
  receiveCount: number,
  dependencies?: {
    readonly process?: typeof processRequest;
    readonly postFailure?: typeof postReleaseNoteFailure;
  }
): Promise<void> {
  const process = dependencies?.process ?? processRequest;
  const postFailure = dependencies?.postFailure ?? postReleaseNoteFailure;
  if (
    isDesktopRelease(request) &&
    receiveCount > DESKTOP_RELEASE_NOTE_FINAL_ATTEMPT
  ) {
    throw new Error(
      'Desktop release-note terminal alert failed and must move to the DLQ'
    );
  }
  try {
    await process(request);
  } catch (error) {
    if (isNonRetryableReleaseNoteError(error)) {
      sentryContext.captureException(error);
      if (!(error instanceof UntrustedReleaseNoteMetadataError)) {
        await postFailure(request, error, receiveCount);
      }
      return;
    }
    const finalAttempt = isDesktopRelease(request)
      ? DESKTOP_RELEASE_NOTE_FINAL_ATTEMPT
      : RELEASE_NOTE_FINAL_ATTEMPT;
    if (receiveCount < finalAttempt) {
      throw error;
    }
    await postFailure(request, error, receiveCount);
    if (!isDesktopRelease(request)) {
      throw error;
    }
  }
}

const sqsHandler: SQSHandler = async (event, context) => {
  // serverless.yaml fixes this event source at batchSize: 1.
  const firstReceiveCount = Number(
    event.Records[0]?.attributes.ApproximateReceiveCount
  );
  const invocationReceiveCount =
    Number.isSafeInteger(firstReceiveCount) && firstReceiveCount > 0
      ? firstReceiveCount
      : 1;
  try {
    await doInDbContext(
      async () => {
        for (const record of event.Records) {
          const request = parseReleaseNoteMessage(record.body);
          logger.info(
            `Generating release notes for ${request.repo} run ${request.run_id}`
          );
          const receiveCount = Number(
            record.attributes.ApproximateReceiveCount
          );
          await processRequestWithRetryPolicy(
            request,
            Number.isSafeInteger(receiveCount) && receiveCount > 0
              ? receiveCount
              : 1,
            {
              process: (queuedRequest) =>
                processRequest(queuedRequest, {
                  getRemainingTimeInMillis: () =>
                    context.getRemainingTimeInMillis()
                })
            }
          );
        }
      },
      { logger }
    );
  } catch (error) {
    if (!shouldRetryReleaseNoteError(error)) {
      logger.error(
        `Release note failed permanently and will not retry: ${getErrorMessage(error)}`,
        error
      );
      sentryContext.captureException(error);
      return;
    }
    if (invocationReceiveCount < RELEASE_NOTE_FINAL_ATTEMPT) {
      logger.warn(
        `Release note attempt ${invocationReceiveCount} failed and will retry: ${getErrorMessage(error)}`
      );
    }
    throw prepareReleaseNoteErrorForRetry(error, invocationReceiveCount);
  }
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler, {
  shouldCaptureException: shouldCaptureReleaseNoteError
});
