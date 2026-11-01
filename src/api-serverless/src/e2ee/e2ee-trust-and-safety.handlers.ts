import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import {
  E2eeTrustAndSafetyService,
  E2EE_TRUST_AND_SAFETY_DEFAULT_PAGE
} from '@/api/e2ee/e2ee-trust-and-safety.service';
import { validateE2ee } from '@/api/e2ee/e2ee.validation';
import { ApiE2eeTrustAndSafetyReport } from '@/api/generated/models/ApiE2eeTrustAndSafetyReport';
import { ApiE2eeTrustAndSafetyReportPage } from '@/api/generated/models/ApiE2eeTrustAndSafetyReportPage';
import {
  E2eeGetTrustAndSafetyReportRequest,
  E2eeListTrustAndSafetyReportsRequest,
  E2eeSetTrustAndSafetyReportHoldRequest
} from '@/api/generated/routes/operations';
import { e2eeDb } from '@/e2ee/e2ee.db';
import { E2EE_BLOB_ID_PATTERN } from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { e2eeTrustAndSafetyGroupId } from '@/e2ee/e2ee-flag';
import { isModerationDeveloper } from '@/content-moderation/moderation-developer-access';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { Request } from 'express';
import * as Joi from 'joi';

// Moderator reads of reported encrypted messages. These routes do not
// depend on the encrypted messaging flag, so stored reports stay reviewable
// if the feature is switched off. Reviewers are the content moderators (the
// same check as the content-moderation queue) plus, when it is set, members
// of E2EE_TRUST_AND_SAFETY_GROUP_ID.

const service = new E2eeTrustAndSafetyService({
  db: e2eeDb,
  now: () => Date.now(),
  isModerator: (profileId, ctx) => isModerationDeveloper(profileId, ctx),
  groupId: () => e2eeTrustAndSafetyGroupId(),
  isGroupMember: async (profileId, groupId) =>
    (
      await userGroupsService.getGroupsUserIsEligibleForByIds(profileId, [
        groupId
      ])
    ).includes(groupId)
});

const listQuerySchema = Joi.object({
  before: Joi.number().integer().min(0).optional(),
  before_id: Joi.string().pattern(E2EE_BLOB_ID_PATTERN).optional(),
  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(E2EE_TRUST_AND_SAFETY_DEFAULT_PAGE)
}).with('before_id', 'before');
const reportIdSchema = Joi.string().pattern(E2EE_BLOB_ID_PATTERN).required();
const holdSchema = Joi.object({ on_hold: Joi.boolean().required() });

async function reviewer(
  req: Request<any, any, any, any, any>
): Promise<{ profileId: string; ctx: RequestContext }> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw e2eeErrors.forbidden('Proxies cannot read reports');
  }
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw e2eeErrors.forbidden('Moderator access is required');
  }
  return { profileId, ctx: { timer, authenticationContext } };
}

export async function handleE2eeListTrustAndSafetyReports(
  req: E2eeListTrustAndSafetyReportsRequest
): Promise<ApiE2eeTrustAndSafetyReportPage> {
  const { profileId, ctx } = await reviewer(req);
  const query = validateE2ee<{
    before?: number;
    before_id?: string;
    limit: number;
  }>(req.query, listQuerySchema);
  return service.listReports(profileId, query, ctx);
}

export async function handleE2eeGetTrustAndSafetyReport(
  req: E2eeGetTrustAndSafetyReportRequest
): Promise<ApiE2eeTrustAndSafetyReport> {
  const { profileId, ctx } = await reviewer(req);
  return service.getReport(
    profileId,
    validateE2ee<string>(req.params.report_id, reportIdSchema),
    ctx
  );
}

export async function handleE2eeSetTrustAndSafetyReportHold(
  req: E2eeSetTrustAndSafetyReportHoldRequest
): Promise<ApiE2eeTrustAndSafetyReport> {
  const { profileId, ctx } = await reviewer(req);
  const reportId = validateE2ee<string>(req.params.report_id, reportIdSchema);
  const body = validateE2ee<{ on_hold: boolean }>(req.body, holdSchema);
  return service.setHold(profileId, reportId, body.on_hold, ctx);
}
