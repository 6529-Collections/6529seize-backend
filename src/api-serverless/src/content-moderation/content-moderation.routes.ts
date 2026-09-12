import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { contentModerationService } from '@/content-moderation/content-moderation.service';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import {
  ContentReportReason,
  DropModerationStatus
} from '@/entities/IContentModeration';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { numbers } from '@/numbers';
import { dropsService } from '@/api/drops/drops.api.service';
import { broadcastDropModerationChange } from './moderation-broadcast';
import { ApiBlockedProfile } from '@/api/generated/models/ApiBlockedProfile';
import { ApiProfileBlockState } from '@/api/generated/models/ApiProfileBlockState';
import { ApiDropHiddenState } from '@/api/generated/models/ApiDropHiddenState';
import { ApiContentModerationReportResponse } from '@/api/generated/models/ApiContentModerationReportResponse';
import { ApiContentModeratorAccess } from '@/api/generated/models/ApiContentModeratorAccess';
import { ApiContentModerationQueueItem } from '@/api/generated/models/ApiContentModerationQueueItem';
import { ApiContentModerationDropDecisionResponse } from '@/api/generated/models/ApiContentModerationDropDecisionResponse';
import { ApiContentModerationProfileStatusResponse } from '@/api/generated/models/ApiContentModerationProfileStatusResponse';
import { ApiContentModerationProfileListItem } from '@/api/generated/models/ApiContentModerationProfileListItem';
import { ApiContentModerationReportWithdrawalResponse } from '@/api/generated/models/ApiContentModerationReportWithdrawalResponse';
import { ApiContentModerationUserReport } from '@/api/generated/models/ApiContentModerationUserReport';
import { assertModerationDeveloper } from '@/content-moderation/moderation-developer-access';
import { CustomApiCompliantException } from '@/exceptions';

const router = asyncRouter();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

async function getRequiredProfileId(req: Request): Promise<{
  profileId: string;
  timer: Timer;
  authenticationContext: Awaited<ReturnType<typeof getAuthenticationContext>>;
}> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(
      'Content moderation actions cannot be performed through a proxy'
    );
  }
  const profileId = authenticationContext.getActingAsId();
  if (!profileId) {
    throw new ForbiddenException('Please create a profile first');
  }
  return { profileId, timer, authenticationContext };
}

const ReportSchema = Joi.object({
  reason: Joi.string()
    .valid(...Object.values(ContentReportReason))
    .required(),
  notes: Joi.string().trim().max(1000).allow('', null).default(null),
  hide_drop: Joi.boolean().default(true),
  block_author: Joi.boolean().default(false)
}).required();

router.get(
  '/blocked-profiles',
  needsAuthenticatedUser(),
  async (req: Request, res: Response<ApiBlockedProfile[]>) => {
    const { profileId } = await getRequiredProfileId(req);
    res.send(await contentModerationDb.listBlockedProfiles(profileId));
  }
);

router.put(
  '/profiles/:profile_id/block',
  needsAuthenticatedUser(),
  async (
    req: Request<{ profile_id: string }>,
    res: Response<ApiProfileBlockState>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    await contentModerationDb.blockProfile(profileId, req.params.profile_id, {
      timer,
      authenticationContext
    });
    res.send({ blocked: true });
  }
);

router.delete(
  '/profiles/:profile_id/block',
  needsAuthenticatedUser(),
  async (
    req: Request<{ profile_id: string }>,
    res: Response<ApiProfileBlockState>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    await contentModerationDb.unblockProfile(profileId, req.params.profile_id, {
      timer,
      authenticationContext
    });
    res.send({ blocked: false });
  }
);

router.put(
  '/drops/:drop_id/hide',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }>,
    res: Response<ApiDropHiddenState>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    await dropsService.findDropByIdOrThrow(
      { dropId: req.params.drop_id },
      { timer, authenticationContext }
    );
    await contentModerationDb.hideDrop(profileId, req.params.drop_id, {
      timer,
      authenticationContext
    });
    res.send({ hidden: true });
  }
);

router.delete(
  '/drops/:drop_id/hide',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }>,
    res: Response<ApiDropHiddenState>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    await contentModerationDb.unhideDrop(profileId, req.params.drop_id, {
      timer,
      authenticationContext
    });
    res.send({ hidden: false });
  }
);

router.post(
  '/drops/:drop_id/reports',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }>,
    res: Response<ApiContentModerationReportResponse>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    await dropsService.findDropByIdOrThrow(
      { dropId: req.params.drop_id },
      { timer, authenticationContext }
    );
    const body = getValidatedByJoiOrThrow(req.body, ReportSchema);
    const result = await contentModerationService.submitReport(
      {
        dropId: req.params.drop_id,
        reporterProfileId: profileId,
        reason: body.reason,
        notes: body.notes || null,
        hideDrop: true,
        blockAuthor: body.block_author
      },
      { timer, authenticationContext }
    );
    if (result.drop_status !== DropModerationStatus.VISIBLE) {
      await broadcastDropModerationChange(req.params.drop_id, timer);
    }
    res
      .status(201)
      .send(result as unknown as ApiContentModerationReportResponse);
  }
);

router.delete(
  '/drops/:drop_id/reports/mine',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }>,
    res: Response<ApiContentModerationReportWithdrawalResponse>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const result = await contentModerationService.withdrawReport(
      profileId,
      req.params.drop_id,
      { timer, authenticationContext }
    );
    await broadcastDropModerationChange(req.params.drop_id, timer);
    res.send(result as unknown as ApiContentModerationReportWithdrawalResponse);
  }
);

router.get(
  '/moderator-access',
  needsAuthenticatedUser(),
  async (req: Request, res: Response<ApiContentModeratorAccess>) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    res.send(
      await contentModerationService.getModeratorAccess(profileId, {
        timer,
        authenticationContext
      })
    );
  }
);

router.get(
  '/reports/mine',
  needsAuthenticatedUser(),
  async (
    req: Request<
      Record<string, string>,
      unknown,
      unknown,
      { limit?: string; before?: string }
    >,
    res: Response<ApiContentModerationUserReport[]>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const limit = numbers.parseIntOrNull(req.query.limit) ?? 50;
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    const before = req.query.before?.trim() || undefined;
    res.send(
      (await contentModerationService.getReportsForProfile(
        profileId,
        { limit, before },
        { timer, authenticationContext }
      )) as unknown as ApiContentModerationUserReport[]
    );
  }
);

router.get(
  '/reports',
  needsAuthenticatedUser(),
  async (
    req: Request<
      Record<string, string>,
      unknown,
      unknown,
      { limit?: string; before?: string; view?: string }
    >,
    res: Response<ApiContentModerationQueueItem[]>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const limit = numbers.parseIntOrNull(req.query.limit) ?? 50;
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    const before = req.query.before?.trim() || undefined;
    const view = req.query.view?.trim().toUpperCase() || 'OPEN';
    if (view !== 'OPEN' && view !== 'RESOLVED') {
      throw new BadRequestException('View must be OPEN or RESOLVED');
    }
    const result = await contentModerationService.getQueue(
      profileId,
      { limit, before, view },
      { timer, authenticationContext }
    );
    res.send(result as unknown as ApiContentModerationQueueItem[]);
  }
);

router.get(
  '/profiles/suspended',
  needsAuthenticatedUser(),
  async (
    req: Request<
      Record<string, string>,
      unknown,
      unknown,
      { limit?: string; before?: string }
    >,
    res: Response<ApiContentModerationProfileListItem[]>
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const limit = numbers.parseIntOrNull(req.query.limit) ?? 50;
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    const before = req.query.before?.trim() || undefined;
    const result = await contentModerationService.getSuspendedProfiles(
      profileId,
      { limit, before },
      { timer, authenticationContext }
    );
    res.send(result as unknown as ApiContentModerationProfileListItem[]);
  }
);

router.post(
  '/drops/:drop_id/decision',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }>,
    _res: Response<ApiContentModerationDropDecisionResponse>
  ) => {
    const { timer, authenticationContext } = await getRequiredProfileId(req);
    assertModerationDeveloper({ timer, authenticationContext });
    throw new CustomApiCompliantException(
      409,
      'Open the moderation check and review its latest revision before acting.',
      'MODERATION_REVIEW_REQUIRED'
    );
  }
);

router.post(
  '/profiles/:profile_id/status',
  needsAuthenticatedUser(),
  async (
    req: Request<{ profile_id: string }>,
    _res: Response<ApiContentModerationProfileStatusResponse>
  ) => {
    const { timer, authenticationContext } = await getRequiredProfileId(req);
    assertModerationDeveloper({ timer, authenticationContext });
    throw new CustomApiCompliantException(
      409,
      'Open the moderation profile check and review its latest revision before acting.',
      'MODERATION_REVIEW_REQUIRED'
    );
  }
);

export default router;
