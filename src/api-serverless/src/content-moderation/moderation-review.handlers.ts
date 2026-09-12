import { Request } from 'express';
import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { Timer } from '@/time';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  assertModerationDeveloper,
  isModerationDeveloper
} from '@/content-moderation/moderation-developer-access';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import {
  moderationReviewService,
  itemSummary
} from '@/content-moderation/moderation-review.service';
import {
  MODERATION_ACTIONS,
  MODERATION_SUBJECTS,
  ModerationFilter,
  ModerationAction
} from '@/content-moderation/moderation-review.types';
import {
  GetModerationAccessRequest,
  GetModerationChecksRequest,
  GetModerationCheckRequest,
  GetModerationCountsRequest,
  GetModerationProfileCheckRequest,
  GetModerationReportCheckRequest,
  ModerationCheckActionRequest
} from '@/api/generated/routes/operations';
import { ApiModerationAccess } from '@/api/generated/models/ApiModerationAccess';
import { ApiModerationCheckPage } from '@/api/generated/models/ApiModerationCheckPage';
import { ApiModerationCheckDetail } from '@/api/generated/models/ApiModerationCheckDetail';
import { ApiModerationCounts } from '@/api/generated/models/ApiModerationCounts';
import { broadcastDropModerationChange } from './moderation-broadcast';

async function context<P, R, B, Q>(req: Request<P, R, B, Q>) {
  req.res?.setHeader('Cache-Control', 'private, no-store');
  const timer = Timer.getFromRequest(req);
  return {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
}
const filters = Joi.object<ModerationFilter>({
  subject_type: Joi.string().valid(...MODERATION_SUBJECTS),
  outcome: Joi.string().valid('ALLOW', 'REJECT', 'ERROR', 'PENDING'),
  policy_family: Joi.string().valid('PUBLIC_FIELDS', 'WAVE_CONTENT'),
  trigger: Joi.string().max(64),
  review_status: Joi.string().valid('NEEDS_REVIEW', 'REVIEWED'),
  from: Joi.number().integer().min(0),
  to: Joi.number().integer().min(0),
  profile_id: Joi.string().max(50),
  subject_id: Joi.string().max(200),
  before: Joi.string().max(150),
  limit: Joi.number().integer().min(1).max(100).default(50)
}).unknown(false);
const actionSchema = Joi.object({
  action: Joi.string()
    .valid(...MODERATION_ACTIONS)
    .required(),
  reason: Joi.string().trim().min(1).max(2000).required(),
  expected_version: Joi.number().integer().min(1).required(),
  idempotency_key: Joi.string().guid().required()
})
  .unknown(false)
  .required();
export async function handleGetModerationAccess(
  req: GetModerationAccessRequest
): Promise<ApiModerationAccess> {
  const ctx = await context(req);
  return {
    developer:
      !ctx.authenticationContext.isAuthenticatedAsProxy() &&
      isModerationDeveloper(ctx.authenticationContext.getActingAsId())
  };
}
export async function handleGetModerationChecks(
  req: GetModerationChecksRequest
): Promise<ApiModerationCheckPage> {
  const ctx = await context(req);
  assertModerationDeveloper(ctx);
  const page = await moderationReviewDb.list(
    getValidatedByJoiOrThrow(req.query, filters),
    ctx
  );
  return {
    items: page.items.map(itemSummary),
    next_cursor: page.next_cursor
  } as unknown as ApiModerationCheckPage;
}
export async function handleGetModerationCounts(
  req: GetModerationCountsRequest
): Promise<ApiModerationCounts> {
  const ctx = await context(req);
  assertModerationDeveloper(ctx);
  const counts = await moderationReviewDb.counts(ctx);
  return {
    needs_review: Number(counts?.needs_review ?? 0),
    quarantined: Number(counts?.quarantined ?? 0),
    rejected_today: Number(counts?.rejected_today ?? 0),
    evaluator_failures_today: Number(counts?.evaluator_failures_today ?? 0)
  };
}
export async function handleGetModerationCheck(
  req: GetModerationCheckRequest
): Promise<ApiModerationCheckDetail> {
  return (await moderationReviewService.detail(
    req.params.id,
    await context(req)
  )) as unknown as ApiModerationCheckDetail;
}
export async function handleModerationCheckAction(
  req: ModerationCheckActionRequest
): Promise<ApiModerationCheckDetail> {
  const ctx = await context(req);
  assertModerationDeveloper(ctx);
  const body = getValidatedByJoiOrThrow(req.body, actionSchema) as {
    action: ModerationAction;
    reason: string;
    expected_version: number;
    idempotency_key: string;
  };
  const detail = await moderationReviewService.action(req.params.id, body, ctx);
  if (
    detail.check.subject_type === 'DROP' &&
    detail.check.published_subject_id &&
    ['RESTORE', 'QUARANTINE', 'REMOVE'].includes(body.action)
  ) {
    await broadcastDropModerationChange(
      detail.check.published_subject_id,
      ctx.timer
    );
  }
  return detail as unknown as ApiModerationCheckDetail;
}
export async function handleGetModerationReportCheck(
  req: GetModerationReportCheckRequest
): Promise<ApiModerationCheckDetail> {
  return (await moderationReviewService.reportCheck(
    req.params.report_id,
    await context(req)
  )) as unknown as ApiModerationCheckDetail;
}
export async function handleGetModerationProfileCheck(
  req: GetModerationProfileCheckRequest
): Promise<ApiModerationCheckDetail> {
  return (await moderationReviewService.profileCheck(
    req.params.profile_id,
    await context(req)
  )) as unknown as ApiModerationCheckDetail;
}
