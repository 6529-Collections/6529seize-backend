import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { dropCreationService } from './drop-creation.api.service';
import { dropsService } from './drops.api.service';
import { parseIntOrNull, parseNumberOrNull } from '../../../helpers';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { dropRaterService } from './drop-rater.service';
import { FullPageRequest, Page, PageSortDirection } from '../page-request';
import { Drop } from '../generated/models/Drop';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { userGroupsService } from '../community-members/user-groups.service';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  ApiAddRatingToDropRequest,
  ApiAddRatingToDropRequestSchema,
  NewDropSchema
} from './drop.validator';
import { profilesService } from '../../../profiles/profiles.service';
import { AuthenticationContext } from '../../../auth-context';
import { DropSubscriptionActions } from '../generated/models/DropSubscriptionActions';
import { DropSubscriptionTargetAction } from '../generated/models/DropSubscriptionTargetAction';
import { Timer } from '../../../time';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        limit: number;
        group_id?: string;
        serial_no_less_than?: number;
        author?: string;
        min_part_id?: number;
        max_part_id?: number;
        wave_id?: string;
        include_replies?: string;
      },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const {
      limit,
      wave_id,
      group_id,
      min_part_id,
      max_part_id,
      author_id,
      include_replies
    } = await prepLatestDropsSearchQuery(req);
    const latestDrops = await dropsService.findLatestDrops({
      amount: limit < 0 || limit > 20 ? 10 : limit,
      group_id: group_id,
      serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
      min_part_id,
      max_part_id,
      wave_id,
      author_id,
      include_replies,
      authenticationContext
    });
    res.send(latestDrops);
  }
);

router.get(
  '/:drop_id',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { drop_id: string },
      any,
      any,
      { min_part_id?: number; max_part_id?: number },
      any
    >,
    res: Response<ApiResponse<Drop>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const { dropId, min_part_id, max_part_id } =
      prepSingleDropSearchRequest(req);
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id,
      max_part_id
    });
    res.send(drop);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateDropRequest, any, any>,
    res: Response<ApiResponse<Drop>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const authorProfileId = authenticationContext.getActingAsId();
    if (!authorProfileId) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a drop'
      );
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to create drops`
      );
    }
    const apiRequest = req.body;
    const newDrop: CreateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      NewDropSchema
    );
    const invalidPart = newDrop.parts.find(
      (part) =>
        (part.content?.trim()?.length ?? 0) === 0 && part.media.length === 0
    );
    if (invalidPart) {
      throw new BadRequestException(
        'Each drop part must have content or media attached'
      );
    }
    const contentLength = newDrop.parts
      .map((part) => part.content ?? '')
      .join('').length;
    if (contentLength > 32768) {
      throw new BadRequestException(
        'Total content length of all parts must be less than 32768 characters'
      );
    }
    const createDropRequest: CreateDropRequest & {
      author: { external_id: string };
    } = {
      author: { external_id: authorProfileId },
      title: newDrop.title,
      parts: newDrop.parts,
      referenced_nfts: newDrop.referenced_nfts,
      mentioned_users: newDrop.mentioned_users,
      metadata: newDrop.metadata,
      wave_id: newDrop.wave_id,
      reply_to: newDrop.reply_to
    };
    const createdDrop = await dropCreationService.createDrop(
      createDropRequest,
      authenticationContext,
      timer
    );
    res.send(createdDrop);
  }
);

router.post(
  `/:drop_id/ratings`,
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, ApiAddRatingToDropRequest, any, any>,
    res: Response<ApiResponse<Drop>>
  ) => {
    const { rating, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRatingToDropRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
      );
    }
    const dropId = req.params.drop_id;
    if (proposedCategory !== '') {
      const abusivenessDetectionResult =
        await abusivenessCheckService.checkRepPhrase(category);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(
          abusivenessDetectionResult.explanation ??
            'Given category is not allowed'
        );
      }
    }
    const raterProfileId = authenticationContext.getActingAsId()!;
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.RATE_WAVE_DROP
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to rate drops`
      );
    }
    const group_ids_user_is_eligible_for =
      await userGroupsService.getGroupsUserIsEligibleFor(raterProfileId);
    await dropRaterService.updateRating({
      rater_profile_id: raterProfileId,
      groupIdsUserIsEligibleFor: group_ids_user_is_eligible_for,
      category: proposedCategory,
      drop_id: dropId,
      rating: rating
    });
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id: 1,
      max_part_id: 1
    });
    res.send(drop);
  }
);

router.get(
  `/:drop_id/parts/:drop_part_id/replies`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { drop_id: string; drop_part_id: string },
      any,
      any,
      FullPageRequest<'created_at'>,
      any
    >,
    res: Response<Page<Drop>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const { drop_part_id, drop_id, query } = await prepDropPartQuery(
      req,
      authenticationContext
    );
    const replies = await dropsService.findDropReplies(
      {
        ...query,
        drop_part_id,
        drop_id
      },
      authenticationContext.getActingAsId()
    );
    res.send(replies);
  }
);

router.post(
  '/:drop_id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, DropSubscriptionActions, any, any>,
    res: Response<ApiResponse<DropSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read drops or subscribe to them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      DropSubscriptionActionsSchema
    );
    const activeActions = await dropsService.addDropSubscriptionActions({
      dropId: req.params.drop_id,
      subscriber: authenticatedProfileId,
      actions: request.actions,
      authenticationContext
    });
    res.send({
      actions: activeActions
    });
  }
);

router.delete(
  '/:drop_id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, DropSubscriptionActions, any, any>,
    res: Response<ApiResponse<DropSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read drops or unsubscribe for them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      DropSubscriptionActionsSchema
    );
    const activeActions = await dropsService.removeDropSubscriptionActions({
      dropId: req.params.drop_id,
      subscriber: authenticatedProfileId,
      actions: request.actions,
      authenticationContext
    });
    res.send({
      actions: activeActions
    });
  }
);

export function prepSingleDropSearchRequest(
  req: Request<
    { drop_id: string },
    any,
    any,
    { min_part_id?: number; max_part_id?: number },
    any
  >
) {
  const dropId = req.params.drop_id;
  let min_part_id = parseIntOrNull(req.query.min_part_id);
  if (!min_part_id || min_part_id < 1) {
    min_part_id = 0;
  }
  let max_part_id = parseIntOrNull(req.query.max_part_id);
  if (!max_part_id || max_part_id < 1) {
    max_part_id = Number.MAX_SAFE_INTEGER;
  }
  return { dropId, min_part_id, max_part_id };
}

export async function prepLatestDropsSearchQuery(
  req: Request<
    any,
    any,
    any,
    {
      limit: number;
      group_id?: string;
      serial_no_less_than?: number;
      author?: string;
      min_part_id?: number;
      max_part_id?: number;
      wave_id?: string;
      include_replies?: string;
    },
    any
  >
) {
  const limit = parseNumberOrNull(req.query.limit) ?? 10;
  const wave_id = req.query.wave_id ?? null;
  const group_id = req.query.group_id ?? null;
  const include_replies = req.query.include_replies === 'true';
  let min_part_id = parseIntOrNull(req.query.min_part_id);
  if (!min_part_id || min_part_id < 1) {
    min_part_id = 0;
  }
  let max_part_id = parseIntOrNull(req.query.max_part_id);
  if (!max_part_id || max_part_id < 1) {
    max_part_id = Number.MAX_SAFE_INTEGER;
  }
  if (max_part_id < min_part_id) {
    throw new BadRequestException(
      'max_part_id must be greater or equal than min_part_id'
    );
  }
  const author_id = req.query.author
    ? await profilesService
        .resolveIdentityOrThrowNotFound(req.query.author)
        .then((it) => {
          const profileId = it.profile_id;
          if (!profileId) {
            throw new NotFoundException(`Author ${req.query.author} not found`);
          }
          return profileId;
        })
    : null;
  return {
    limit,
    wave_id,
    group_id,
    min_part_id,
    max_part_id,
    author_id,
    include_replies
  };
}

export async function prepDropPartQuery(
  req: Request<
    {
      drop_id: string;
      drop_part_id: string;
    },
    any,
    any,
    FullPageRequest<'created_at'>,
    any
  >,
  authenticationContext?: AuthenticationContext
) {
  const drop_part_id = parseIntOrNull(req.params.drop_part_id);
  const drop_id = req.params.drop_id;
  if (drop_part_id === null) {
    throw new NotFoundException(
      `Drop part ${drop_id}/${req.params.drop_part_id} not found`
    );
  }
  await dropsService
    .findDropByIdOrThrow({
      authenticationContext,
      dropId: drop_id,
      min_part_id: drop_part_id,
      max_part_id: drop_part_id
    })
    .then((drop) => {
      if (drop.parts.length === 0) {
        throw new NotFoundException(
          `Drop part ${drop_id}/${req.params.drop_part_id} not found`
        );
      }
    });
  const query = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<FullPageRequest<'created_at'>>({
      sort_direction: Joi.string()
        .optional()
        .default(PageSortDirection.DESC)
        .valid(...Object.values(PageSortDirection)),
      sort: Joi.string().optional().default('created_at').valid('created_at'),
      page: Joi.number().integer().min(1).optional().default(1),
      page_size: Joi.number().integer().min(1).max(50).optional().default(20)
    })
  );
  return { drop_part_id, drop_id, query };
}

const DropSubscriptionActionsSchema = Joi.object<DropSubscriptionActions>({
  actions: Joi.array()
    .items(Joi.string().valid(...Object.values(DropSubscriptionTargetAction)))
    .required()
});

export default router;
