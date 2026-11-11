import { env } from '@/env';
import { Logger } from '@/logging';
import { redisGet, redisSetJson } from '@/redis';
import { Time } from '@/time';
import { createHash } from 'node:crypto';
import type { PrePublicationAssessment } from './content-moderation-ai.service';

const logger = Logger.get('PRE_PUBLICATION_EVALUATOR');

/** Same content and same policy version reuse a verdict for this long. */
export const PRE_PUBLICATION_VERDICT_CACHE_TTL = Time.minutes(10);
const VERDICT_CACHE_KEY_PREFIX = 'content_moderation_pre_publication_verdict';

export const PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT_ENV =
  'CONTENT_MODERATION_EVALUATOR_PROFILE_HOURLY_LIMIT';
export const DEFAULT_PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT = 20;
export const PRE_PUBLICATION_EVALUATOR_BUDGET_WINDOW = Time.hours(1);

/** Evaluator calls one profile may cause per rolling hour. */
export function getPrePublicationEvaluatorProfileHourlyLimit(): number {
  const raw = env.getStringOrNull(
    PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT_ENV
  );
  if (!raw?.trim()) {
    return DEFAULT_PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${PRE_PUBLICATION_EVALUATOR_PROFILE_HOURLY_LIMIT_ENV} must be a positive integer`
    );
  }
  return value;
}

export function prePublicationVerdictCacheKey({
  policyVersion,
  modelId,
  signal,
  content
}: {
  readonly policyVersion: string;
  readonly modelId: string;
  readonly signal: string;
  readonly content: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([policyVersion, modelId, signal, content]))
    .digest('hex');
  return `${VERDICT_CACHE_KEY_PREFIX}:${digest}`;
}

export interface PrePublicationVerdictCache {
  get(key: string): Promise<PrePublicationAssessment | null>;
  set(key: string, assessment: PrePublicationAssessment): Promise<void>;
}

/** Shared verdict cache; reads and writes give up quietly without Redis. */
export const redisPrePublicationVerdictCache: PrePublicationVerdictCache = {
  async get(key) {
    try {
      return await redisGet<PrePublicationAssessment>(key);
    } catch (error) {
      logger.warn('Pre-publication verdict cache read failed', error);
      return null;
    }
  },
  async set(key, assessment) {
    try {
      await redisSetJson(key, assessment, PRE_PUBLICATION_VERDICT_CACHE_TTL);
    } catch (error) {
      logger.warn('Pre-publication verdict cache write failed', error);
    }
  }
};

export type PrePublicationEvaluatorEvent =
  | 'INVOKED'
  | 'CACHED_VERDICT'
  | 'BUDGET_EXCEEDED'
  | 'ERROR_FALLBACK_ALLOW';

export const PRE_PUBLICATION_EVALUATOR_FALLBACK_LOG_MARKER =
  'CONTENT_MODERATION_EVALUATOR_FALLBACK_ALLOW';

function metricEnvironment(): string {
  if ((process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')) {
    return 'staging';
  }
  return process.env.AWS_REGION === 'us-east-1' ? 'prod' : 'unknown';
}

/**
 * One CloudWatch EMF record per evaluator decision in
 * `6529/ContentModeration`, so evaluator errors that fall back to allowing
 * the post can be alarmed on next to cache hits and budget refusals.
 */
export function recordPrePublicationEvaluatorEvent(
  event: PrePublicationEvaluatorEvent
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return;
  }
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/ContentModeration',
              Dimensions: [['Environment', 'Event']],
              Metrics: [{ Name: 'PrePublicationEvaluator', Unit: 'Count' }]
            }
          ]
        },
        Environment: metricEnvironment(),
        Event: event,
        PrePublicationEvaluator: 1
      })}\n`
    );
  } catch {
    // Metrics are best effort.
  }
}
