import * as crypto from 'node:crypto';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import { env } from '@/env';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { Timer } from '@/time';
import { asyncRouter } from '@/api/async.router';
import { ApiResponse } from '@/api/api-response';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { RELEASE_NOTE_DEPLOYED_AT_PATTERN } from '@/release-notes/release-note-generation-queue';
import {
  CiPipelineAlertRequest,
  ciPipelineAlertService
} from './ci-pipeline-alert.service';

const router = asyncRouter();
const logger = Logger.get('CiPipelineAlertRoutes');

const CI_PIPELINE_ALERT_SIGNATURE_SKEW_SECONDS = 300;
const CI_PIPELINE_ALERT_DEDUPE_TTL_SECONDS = 86400;
const CI_PIPELINE_ALERT_PROCESSING_LOCK_TTL_SECONDS = 300;

const CiPipelineAlertRequestSchema: Joi.ObjectSchema<CiPipelineAlertRequest> =
  Joi.object<CiPipelineAlertRequest>({
    repo: Joi.string().trim().min(1).max(200).required(),
    workflow: Joi.string().trim().min(1).max(200).required(),
    status: Joi.string().valid('success', 'failure').required(),
    title: Joi.string().trim().min(1).max(250).required(),
    description: Joi.string().trim().max(5000).allow(null, '').optional(),
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
    publish_release_note: Joi.boolean().optional(),
    deployed_at: Joi.string()
      .isoDate()
      .pattern(RELEASE_NOTE_DEPLOYED_AT_PATTERN)
      .strict()
      .allow(null, '')
      .optional()
  }).unknown(false);

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
        request.sha ?? '',
        request.branch ?? '',
        request.environment ?? '',
        request.service ?? ''
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
): Promise<void> {
  const { cacheKey, lockAcquired, processingKey, redis } = processingState;

  try {
    await ciPipelineAlertService.postAlert(request, {
      timer: Timer.getFromRequest(req)
    });
    if (redis && lockAcquired) {
      await markCiPipelineAlertProcessed(redis, cacheKey);
    }
  } catch (err) {
    logger.error(`Failed to post CI pipeline alert ${cacheKey}: ${err}`);
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
    res: Response<ApiResponse<Record<string, never>>>
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
      return res.send({});
    }

    await postCiPipelineAlert(request, processingState, req);
    return res.send({});
  }
);

export default router;
