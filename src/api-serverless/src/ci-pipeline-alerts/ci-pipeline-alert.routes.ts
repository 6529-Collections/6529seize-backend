import * as crypto from 'node:crypto';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import { env } from '@/env';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { Timer } from '@/time';
import { asyncRouter } from '@/api/async.router';
import { ApiResponse } from '@/api/api-response';
import { isDeployService } from '@/api/deploy/deploy.config';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { RELEASE_NOTE_DEPLOYED_AT_PATTERN } from '@/release-notes/release-note-generation-queue';
import { GITHUB_CONTRIBUTOR_LOGIN_PATTERN } from '@/release-notes/release-note-contributors.config';
import {
  CiPipelineAlertOutcome,
  CiPipelineAlertRequest,
  ciPipelineAlertService,
  verifiedContributorGithubLogins
} from './ci-pipeline-alert.service';

const router = asyncRouter();
const logger = Logger.get('CiPipelineAlertRoutes');

const CI_PIPELINE_ALERT_SIGNATURE_SKEW_SECONDS = 300;
const CI_PIPELINE_ALERT_DEDUPE_TTL_SECONDS = 86400;
const CI_PIPELINE_ALERT_PROCESSING_LOCK_TTL_SECONDS = 300;

function getE2EValidationError(value: CiPipelineAlertRequest): string | null {
  if (value.alert_type === 'web_e2e') {
    if (value.repo !== '6529seize-frontend' || value.service !== 'web') {
      return 'web_e2e alerts are supported only for the frontend web service';
    }
    return value.validation_pack?.trim()
      ? null
      : 'validation_pack is required for web_e2e alerts';
  }

  const hasE2EIdentity = [
    value.parent_deploy_run_id,
    value.parent_release_train_id,
    value.validation_pack
  ].some((field) => typeof field === 'string' && field.trim().length > 0);
  return hasE2EIdentity
    ? 'E2E deployment identity fields require alert_type web_e2e'
    : null;
}

const CiPipelineAlertRequestSchema: Joi.ObjectSchema<CiPipelineAlertRequest> =
  Joi.object<CiPipelineAlertRequest>({
    alert_type: Joi.string()
      .valid('workflow', 'deploy', 'web_e2e')
      .default('workflow'),
    repo: Joi.string().trim().min(1).max(200).required(),
    workflow: Joi.string().trim().min(1).max(200).required(),
    status: Joi.string().valid('success', 'failure').required(),
    title: Joi.string().trim().min(1).max(250).required(),
    description: Joi.string().trim().max(5000).allow(null, '').optional(),
    triggered_by_github_login: Joi.string()
      .trim()
      .min(1)
      .max(100)
      .allow(null, '')
      .optional(),
    run_id: Joi.string().trim().min(1).max(100).required(),
    run_number: Joi.string().trim().max(100).allow(null, '').optional(),
    run_url: Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] })
      .max(1000)
      .required(),
    sha: Joi.string().trim().max(100).allow(null, '').optional(),
    branch: Joi.string().trim().max(200).allow(null, '').optional(),
    environment: Joi.string()
      .trim()
      .lowercase()
      .valid('staging', 'prod', 'production')
      .required(),
    service: Joi.string().trim().max(200).allow(null, '').optional(),
    run_attempt: Joi.number()
      .integer()
      .min(1)
      .max(1_000_000)
      .allow(null)
      .optional(),
    parent_deploy_run_id: Joi.string()
      .trim()
      .pattern(/^[1-9]\d{0,19}$/)
      .allow(null, '')
      .optional(),
    parent_release_train_id: Joi.string()
      .trim()
      .pattern(/^[A-Za-z0-9._-]{1,100}$/)
      .allow(null, '')
      .optional(),
    validation_pack: Joi.string()
      .trim()
      .pattern(/^[A-Za-z0-9._-]{1,100}$/)
      .allow(null, '')
      .optional(),
    release_train_id: Joi.string()
      .trim()
      .guid({ version: ['uuidv4'] })
      .allow(null, '')
      .optional(),
    release_operation_key: Joi.string()
      .trim()
      .pattern(/^rb2:[A-Za-z0-9:._-]{1,200}:a[1-9]\d{0,8}$/)
      .max(240)
      .allow(null, '')
      .optional(),
    contributor_github_logins: Joi.array()
      .items(
        Joi.string().trim().max(39).pattern(GITHUB_CONTRIBUTOR_LOGIN_PATTERN)
      )
      .max(100)
      .optional(),
    contributor_evidence: Joi.string()
      .valid('release-bus-operation', 'manual-pr', 'manual-range')
      .allow(null)
      .optional(),
    release_notes_prompt_path: Joi.string()
      .trim()
      .max(300)
      .pattern(/^[a-zA-Z0-9._/-]+$/)
      .allow(null, '')
      .optional(),
    release_group_id: Joi.string().trim().max(200).allow(null, '').optional(),
    release_group_services: Joi.array()
      .items(Joi.string().trim().min(1).max(200))
      .min(1)
      .max(100)
      .optional(),
    pull_request_number: Joi.number()
      .integer()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .allow(null)
      .optional(),
    publish_release_note: Joi.boolean().strict().optional(),
    release_note_groups: Joi.array()
      .items(
        Joi.object({
          release_group_id: Joi.string().trim().min(1).max(200).required(),
          release_group_services: Joi.array()
            .items(Joi.string().trim().min(1).max(200))
            .min(1)
            .max(100)
            .unique()
            .required(),
          pull_request_number: Joi.number()
            .integer()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .required(),
          publish_release_note: Joi.boolean().strict().required()
        }).unknown(false)
      )
      .min(1)
      .max(100)
      .unique('pull_request_number')
      .unique('release_group_id')
      .optional(),
    release_version: Joi.string()
      .trim()
      .pattern(/^\d+\.\d+\.\d+$/)
      .allow(null, '')
      .optional(),
    frontend_sha: Joi.string()
      .trim()
      .lowercase()
      .pattern(/^[a-f0-9]{40}$/)
      .allow(null, '')
      .optional(),
    deployed_at: Joi.string()
      .isoDate()
      .pattern(RELEASE_NOTE_DEPLOYED_AT_PATTERN)
      .strict()
      .allow(null, '')
      .optional()
  })
    .unknown(false)
    .custom((value, helpers) => {
      // Accept the legacy train-plus-contributors shape during the ordered
      // backend-first rollout. The service deliberately ignores contributors
      // unless the new signed evidence contract is also present.
      const repoName = value.repo.split('/').pop()?.toLowerCase();
      const hasDesktopFields = Boolean(
        value.release_version?.trim() || value.frontend_sha?.trim()
      );
      if (
        (hasDesktopFields ||
          (repoName === '6529-core' &&
            value.release_notes_prompt_path?.trim())) &&
        (repoName !== '6529-core' ||
          !value.release_version?.trim() ||
          !value.frontend_sha?.trim())
      ) {
        return helpers.message({
          custom:
            'release_version and frontend_sha must be supplied together for 6529-core'
        });
      }
      if (
        value.contributor_evidence === 'release-bus-operation' &&
        (!value.release_train_id?.trim() ||
          !value.release_operation_key?.trim())
      )
        return helpers.message({
          custom:
            'release_train_id and release_operation_key are required for release-bus contributor evidence'
        });
      if (
        (value.contributor_evidence === 'manual-pr' ||
          value.contributor_evidence === 'manual-range') &&
        (value.release_train_id?.trim() || value.release_operation_key?.trim())
      )
        return helpers.message({
          custom:
            'manual contributor evidence cannot include Release Bus identity'
        });
      const e2eValidationError = getE2EValidationError(value);
      if (e2eValidationError) {
        return helpers.message({ custom: e2eValidationError });
      }
      const groups = value.release_note_groups;
      if (!groups) return value;
      const service = value.service?.trim();
      if (!service) {
        return helpers.message({
          custom: 'service is required with release_note_groups'
        });
      }
      if (!isDeployService(service)) {
        return helpers.message({
          custom: 'service must be an allowlisted backend deploy service'
        });
      }
      for (const group of groups) {
        if (!group.release_group_services.every(isDeployService)) {
          return helpers.message({
            custom:
              'release_group_services must contain only allowlisted backend deploy services'
          });
        }
        if (!group.release_group_services.includes(service)) {
          return helpers.message({
            custom:
              'every release_note_groups entry must contain the deployed service'
          });
        }
      }
      return value;
    });

type SignatureVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly statusCode: number;
    };

type CiPipelineAlertRedis = NonNullable<ReturnType<typeof getRedisClient>>;

interface CiPipelineAlertProcessingState {
  readonly cacheKey: string;
  readonly processingKey: string;
  readonly redis: CiPipelineAlertRedis | null;
  readonly lockAcquired: boolean;
  readonly shouldSkip: boolean;
}

type CiPipelineAlertAcknowledgement =
  | CiPipelineAlertOutcome
  | {
      readonly ci_drop: 'duplicate';
      readonly release_note: 'duplicate';
    }
  | {
      readonly ci_drop: 'failed';
      readonly release_note: 'not-requested';
    };

function timingSafeEqualHex(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'hex');
  const bBuffer = Buffer.from(b, 'hex');
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function normalizeSignatureHeader(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const signature = value.startsWith('sha256=') ? value.slice(7) : value;
  return /^[a-f0-9]{64}$/i.test(signature) ? signature.toLowerCase() : null;
}

export function computeCiPipelineAlertSignature({
  secret,
  timestamp,
  rawBody
}: {
  readonly secret: string;
  readonly timestamp: string;
  readonly rawBody: Buffer;
}): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
}

function getCiPipelineAlertSecret(): string {
  return env.getStringOrThrow('CI_PIPELINES_ALERT_SECRET');
}

export function verifyCiPipelineAlertSignature(
  req: Request
): SignatureVerificationResult {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return {
      ok: false,
      reason: 'Raw body not available',
      statusCode: 500
    };
  }

  const timestamp = req.get('x-6529-ci-timestamp');
  if (!timestamp) {
    return {
      ok: false,
      reason: 'Missing x-6529-ci-timestamp',
      statusCode: 400
    };
  }
  const timestampNumber = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isInteger(timestampNumber) ||
    Math.abs(nowSeconds - timestampNumber) >
      CI_PIPELINE_ALERT_SIGNATURE_SKEW_SECONDS
  ) {
    return {
      ok: false,
      reason: 'Invalid or expired x-6529-ci-timestamp',
      statusCode: 401
    };
  }

  const providedSignature = normalizeSignatureHeader(
    req.get('x-6529-ci-signature')
  );
  if (!providedSignature) {
    return {
      ok: false,
      reason: 'Missing or invalid x-6529-ci-signature',
      statusCode: 400
    };
  }

  const expectedSignature = computeCiPipelineAlertSignature({
    secret: getCiPipelineAlertSecret(),
    timestamp,
    rawBody
  });
  if (!timingSafeEqualHex(expectedSignature, providedSignature)) {
    return {
      ok: false,
      reason: 'Invalid signature',
      statusCode: 401
    };
  }

  return { ok: true };
}

export function buildCiPipelineAlertDedupeKey(
  request: CiPipelineAlertRequest
): string {
  const verifiedContributors = verifiedContributorGithubLogins(request);
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        request.repo,
        request.workflow,
        request.run_id,
        request.run_url,
        request.status,
        request.title,
        request.description ?? '',
        request.triggered_by_github_login ?? '',
        request.sha ?? '',
        request.branch ?? '',
        request.environment ?? '',
        request.service ?? '',
        request.release_train_id ?? '',
        request.release_operation_key ?? '',
        verifiedContributors.length ? request.contributor_evidence : '',
        verifiedContributors,
        request.alert_type ?? 'workflow',
        request.run_attempt ?? 1,
        request.parent_deploy_run_id ?? '',
        request.parent_release_train_id ?? '',
        request.validation_pack ?? ''
      ])
    )
    .digest('hex');
  return `ci-pipeline-alert:${hash}`;
}

async function prepareCiPipelineAlertProcessing(
  request: CiPipelineAlertRequest
): Promise<CiPipelineAlertProcessingState> {
  const cacheKey = buildCiPipelineAlertDedupeKey(request);
  const processingKey = `${cacheKey}:processing`;
  const redis = getRedisClient();

  if (!redis) {
    logger.warn(
      `Redis dedupe is unavailable for CI pipeline alert ${cacheKey}; posting without dedupe`
    );
    return {
      cacheKey,
      processingKey,
      redis: null,
      lockAcquired: false,
      shouldSkip: false
    };
  }

  try {
    const alreadyProcessed = await redis.get(cacheKey);
    if (alreadyProcessed) {
      logger.info(`Duplicate CI pipeline alert ${cacheKey}, skipping`);
      return {
        cacheKey,
        processingKey,
        redis,
        lockAcquired: false,
        shouldSkip: true
      };
    }

    const lockWasSet = await redis.set(processingKey, '1', {
      NX: true,
      EX: CI_PIPELINE_ALERT_PROCESSING_LOCK_TTL_SECONDS
    });
    if (!lockWasSet) {
      logger.info(`CI pipeline alert ${cacheKey} is already processing`);
      return {
        cacheKey,
        processingKey,
        redis,
        lockAcquired: false,
        shouldSkip: true
      };
    }

    return {
      cacheKey,
      processingKey,
      redis,
      lockAcquired: true,
      shouldSkip: false
    };
  } catch (err) {
    logger.warn(
      `Failed to use Redis dedupe for CI pipeline alert ${cacheKey}; posting without dedupe: ${err}`
    );
    return {
      cacheKey,
      processingKey,
      redis,
      lockAcquired: false,
      shouldSkip: false
    };
  }
}

async function markCiPipelineAlertProcessed(
  redis: CiPipelineAlertRedis,
  cacheKey: string
): Promise<void> {
  try {
    await redis.set(cacheKey, '1', {
      EX: CI_PIPELINE_ALERT_DEDUPE_TTL_SECONDS
    });
  } catch (err) {
    logger.warn(
      `Failed to mark CI pipeline alert ${cacheKey} as processed: ${err}`
    );
  }
}

async function releaseCiPipelineAlertProcessingLock(
  redis: CiPipelineAlertRedis,
  processingKey: string
): Promise<void> {
  try {
    await redis.del(processingKey);
  } catch (err) {
    logger.warn(
      `Failed to release CI pipeline alert processing lock ${processingKey}: ${err}`
    );
  }
}

async function postCiPipelineAlert(
  request: CiPipelineAlertRequest,
  processingState: CiPipelineAlertProcessingState,
  req: Request
): Promise<CiPipelineAlertOutcome | null> {
  const { cacheKey, lockAcquired, processingKey, redis } = processingState;

  try {
    const outcome = await ciPipelineAlertService.postAlert(request, {
      timer: Timer.getFromRequest(req)
    });
    if (redis && lockAcquired) {
      await markCiPipelineAlertProcessed(redis, cacheKey);
    }
    return outcome;
  } catch (err) {
    logger.error(`Failed to post CI pipeline alert ${cacheKey}: ${err}`);
    return null;
  } finally {
    if (redis && lockAcquired) {
      await releaseCiPipelineAlertProcessingLock(redis, processingKey);
    }
  }
}

router.post(
  '/',
  async (
    req: Request<any, any, CiPipelineAlertRequest, any, any>,
    res: Response<ApiResponse<CiPipelineAlertAcknowledgement>>
  ) => {
    const verification = verifyCiPipelineAlertSignature(req);
    if (!verification.ok) {
      logger.warn(`Rejected CI pipeline alert: ${verification.reason}`);
      return res.status(verification.statusCode).send({
        error: verification.reason
      });
    }

    const request = getValidatedByJoiOrThrow(
      req.body,
      CiPipelineAlertRequestSchema
    );
    const processingState = await prepareCiPipelineAlertProcessing(request);
    if (processingState.shouldSkip) {
      return res.send({
        ci_drop: 'duplicate',
        release_note: 'duplicate'
      });
    }

    const outcome = await postCiPipelineAlert(request, processingState, req);
    return res.send(
      outcome ?? {
        ci_drop: 'failed',
        release_note: 'not-requested'
      }
    );
  }
);

export default router;
