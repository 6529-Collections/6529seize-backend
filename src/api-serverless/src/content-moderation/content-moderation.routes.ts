import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { contentModerationService } from '@/content-moderation/content-moderation.service';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import {
  ContentReportReason,
  DropModerationStatus,
  ModeratedProfileStatus
} from '@/entities/IContentModeration';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { Timer } from '@/time';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { numbers } from '@/numbers';
import { dropsService } from '@/api/drops/drops.api.service';
import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { AuthenticationContext } from '@/auth-context';
import { Logger } from '@/logging';

const router = asyncRouter();
const logger = Logger.get('ContentModerationRoutes');

function getRequiredProfileId(req: Request): Promise<{
  profileId: string;
  timer: Timer;
  authenticationContext: Awaited<ReturnType<typeof getAuthenticationContext>>;
}> {
  const timer = Timer.getFromRequest(req);
  return getAuthenticationContext(req, timer).then((authenticationContext) => {
    const profileId = authenticationContext.getActingAsId();
    if (!profileId) {
      throw new ForbiddenException('Please create a profile first');
    }
    return { profileId, timer, authenticationContext };
  });
}

async function broadcastDropModerationChange(
  dropId: string,
  timer: Timer
): Promise<void> {
  try {
    const authenticationContext = AuthenticationContext.notAuthenticated();
    const drop = await dropsService.findDropByIdOrThrow(
      { dropId, skipEligibilityCheck: true },
      { timer, authenticationContext }
    );
    await wsListenersNotifier.notifyAboutDropUpdate(
      drop,
      { timer, authenticationContext },
      { reason: 'CONTENT_MODERATION', useSystemBroadcastAudience: true }
    );
  } catch (error) {
    logger.error(
      `Failed to broadcast moderation change for drop ${dropId}`,
      error
    );
  }
}

const ReportSchema = Joi.object({
  reason: Joi.string()
    .valid(...Object.values(ContentReportReason))
    .required(),
  notes: Joi.string().trim().max(1000).allow('', null).default(null),
  hide_drop: Joi.boolean().default(false),
  block_author: Joi.boolean().default(false)
}).required();

const DropDecisionSchema = Joi.object({
  decision: Joi.string().valid('ALLOW', 'QUARANTINE', 'REMOVE').required(),
  reason: Joi.string().trim().min(1).max(2000).required()
}).required();

const ProfileStatusSchema = Joi.object({
  status: Joi.string()
    .valid(...Object.values(ModeratedProfileStatus))
    .required(),
  reason: Joi.string().trim().min(1).max(2000).required()
}).required();

router.get(
  '/blocked-profiles',
  needsAuthenticatedUser(),
  async (req: Request, res: Response) => {
    const { profileId } = await getRequiredProfileId(req);
    res.send(await contentModerationDb.listBlockedProfiles(profileId));
  }
);

router.put(
  '/profiles/:profile_id/block',
  needsAuthenticatedUser(),
  async (req: Request<{ profile_id: string }>, res: Response) => {
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
  async (req: Request<{ profile_id: string }>, res: Response) => {
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
  async (req: Request<{ drop_id: string }>, res: Response) => {
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
  async (req: Request<{ drop_id: string }>, res: Response) => {
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
  async (req: Request<{ drop_id: string }>, res: Response) => {
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
        hideDrop: body.hide_drop,
        blockAuthor: body.block_author
      },
      { timer, authenticationContext }
    );
    if (result.drop_status !== DropModerationStatus.VISIBLE) {
      await broadcastDropModerationChange(req.params.drop_id, timer);
    }
    res.status(201).send(result);
  }
);

router.get(
  '/moderator-access',
  needsAuthenticatedUser(),
  async (req: Request, res: Response) => {
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
  '/reports',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, { limit?: string; before?: string }>,
    res
  ) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const limit = numbers.parseIntOrNull(req.query.limit) ?? 50;
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('Limit must be between 1 and 100');
    }
    const before = numbers.parseIntOrNull(req.query.before);
    res.send(
      await contentModerationService.getQueue(
        profileId,
        { limit, before },
        { timer, authenticationContext }
      )
    );
  }
);

router.post(
  '/drops/:drop_id/decision',
  needsAuthenticatedUser(),
  async (req: Request<{ drop_id: string }>, res: Response) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const body = getValidatedByJoiOrThrow(req.body, DropDecisionSchema);
    const result = await contentModerationService.decideDrop(
      profileId,
      { dropId: req.params.drop_id, ...body },
      { timer, authenticationContext }
    );
    await broadcastDropModerationChange(req.params.drop_id, timer);
    res.send(result);
  }
);

router.post(
  '/profiles/:profile_id/status',
  needsAuthenticatedUser(),
  async (req: Request<{ profile_id: string }>, res: Response) => {
    const { profileId, timer, authenticationContext } =
      await getRequiredProfileId(req);
    const body = getValidatedByJoiOrThrow(req.body, ProfileStatusSchema);
    res.send(
      await contentModerationService.setProfileStatus(
        profileId,
        { profileId: req.params.profile_id, ...body },
        { timer, authenticationContext }
      )
    );
  }
);

export default router;
