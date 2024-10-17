import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
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
import {
  parseIntOrNull,
  parseNumberOrNull,
  resolveEnum
} from '../../../helpers';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { dropRaterService } from './drop-voting.service';
import { FullPageRequest, Page, PageSortDirection } from '../page-request';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { userGroupsService } from '../community-members/user-groups.service';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  ApiAddRatingToDropRequest,
  ApiAddRatingToDropRequestSchema,
  NewDropSchema,
  UpdateDropSchema
} from './drop.validator';
import { profilesService } from '../../../profiles/profiles.service';
import { ApiDropSubscriptionActions } from '../generated/models/ApiDropSubscriptionActions';
import { ApiDropSubscriptionTargetAction } from '../generated/models/ApiDropSubscriptionTargetAction';
import { Timer } from '../../../time';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import { RequestContext } from '../../../request.context';
import { ApiDropType } from '../generated/models/ApiDropType';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
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
        wave_id?: string;
        include_replies?: string;
        drop_type?: ApiDropType;
      },
      any
    >,
    res: Response<ApiResponse<ApiDrop[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { limit, wave_id, group_id, author_id, include_replies, drop_type } =
      await prepLatestDropsSearchQuery(req);
    const latestDrops = await dropsService.findLatestDrops(
      {
        amount: limit < 0 || limit > 20 ? 10 : limit,
        group_id: group_id,
        serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
        wave_id,
        author_id,
        include_replies,
        drop_type
      },
      { timer, authenticationContext }
    );
    res.send(latestDrops);
  }
);

router.get(
  '/:drop_id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDrop>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const drop = await dropsService.findDropByIdOrThrow(
      {
        dropId
      },
      { timer, authenticationContext }
    );
    res.send(drop);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateDropRequest, any, any>,
    res: Response<ApiResponse<ApiDrop>>
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
        ProfileProxyActionType.CREATE_DROP_TO_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to create drops`
      );
    }
    const apiRequest = req.body;
    const newDrop: ApiCreateDropRequest = getValidatedByJoiOrThrow(
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
    const createDropRequest: ApiCreateDropRequest & {
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
      {
        createDropRequest,
        authorId: authorProfileId,
        representativeId: authenticationContext.isAuthenticatedAsProxy()
          ? authenticationContext.roleProfileId!
          : authorProfileId
      },
      timer
    );
    res.send(createdDrop);
  }
);

router.post(
  '/:drop_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, ApiUpdateDropRequest, any, any>,
    res: Response<ApiResponse<ApiDrop>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    if (!authenticationContext.isUserFullyAuthenticated()) {
      throw new ForbiddenException(`Create a profile before updating a drop`);
    }
    const apiRequest = req.body;
    const updateRequest: ApiUpdateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      UpdateDropSchema
    );
    const authorId = authenticationContext.getActingAsId()!;
    const updatedDrop = await dropCreationService.updateDrop(
      {
        dropId: req.params.drop_id,
        request: updateRequest,
        authorId: authorId,
        representativeId: authenticationContext.getLoggedInUsersProfileId()!
      },
      timer
    );
    res.send(updatedDrop);
  }
);

router.delete(
  '/:drop_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<void>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await dropCreationService.deleteDropById(
      {
        id: req.params.drop_id
      },
      {
        timer,
        authenticationContext
      }
    );
    res.send();
  }
);

router.post(
  `/:drop_id/ratings`,
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, ApiAddRatingToDropRequest, any, any>,
    res: Response<ApiResponse<ApiDrop>>
  ) => {
    const { rating, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRatingToDropRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
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
        ProfileProxyActionType.RATE_WAVE_DROP
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to rate drops`
      );
    }
    const ctx = { timer, authenticationContext };
    const group_ids_user_is_eligible_for =
      await userGroupsService.getGroupsUserIsEligibleFor(raterProfileId, timer);
    await dropRaterService.updateVote(
      {
        rater_profile_id: raterProfileId,
        groupIdsUserIsEligibleFor: group_ids_user_is_eligible_for,
        category: proposedCategory,
        drop_id: dropId,
        rating: rating
      },
      ctx
    );
    const drop = await dropsService.findDropByIdOrThrow(
      {
        dropId
      },
      { authenticationContext, timer }
    );
    res.send(drop);
  }
);

router.get(
  `/:drop_id/parts/:drop_part_id/replies`,
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { drop_id: string; drop_part_id: string; drop_type?: ApiDropType },
      any,
      any,
      FullPageRequest<'created_at'>,
      any
    >,
    res: Response<Page<ApiDrop>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = {
      authenticationContext,
      timer
    };
    const { drop_part_id, drop_id, query, drop_type } = await prepDropPartQuery(
      req,
      ctx
    );
    const replies = await dropsService.findDropReplies(
      {
        ...query,
        drop_part_id,
        drop_id,
        drop_type
      },
      ctx
    );
    res.send(replies);
  }
);

router.post(
  '/:drop_id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { drop_id: string },
      any,
      ApiDropSubscriptionActions,
      any,
      any
    >,
    res: Response<ApiResponse<ApiDropSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.READ_WAVE
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
      actions: request.actions.filter(
        (it) => it !== ApiDropSubscriptionTargetAction.Voted
      ),
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
    req: Request<
      { drop_id: string },
      any,
      ApiDropSubscriptionActions,
      any,
      any
    >,
    res: Response<ApiResponse<ApiDropSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.READ_WAVE
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
      actions: request.actions.filter(
        (it) => it !== ApiDropSubscriptionTargetAction.Voted
      ),
      authenticationContext
    });
    res.send({
      actions: activeActions
    });
  }
);

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
      wave_id?: string;
      include_replies?: string;
      drop_type?: ApiDropType;
    },
    any
  >
) {
  const limit = parseNumberOrNull(req.query.limit) ?? 10;
  const wave_id = req.query.wave_id ?? null;
  const group_id = req.query.group_id ?? null;
  const include_replies = req.query.include_replies === 'true';
  const drop_type_str = (req.query.drop_type as string) ?? null;
  const drop_type_enum = resolveEnum(ApiDropType, drop_type_str) ?? null;
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
    author_id,
    include_replies,
    drop_type: drop_type_enum
  };
}

export async function prepDropPartQuery(
  req: Request<
    {
      drop_id: string;
      drop_part_id: string;
      drop_type?: ApiDropType;
    },
    any,
    any,
    FullPageRequest<'created_at'>,
    any
  >,
  ctx: RequestContext
) {
  const drop_type_str = (req.params.drop_type as string) ?? null;
  const drop_type_enum = resolveEnum(ApiDropType, drop_type_str) ?? null;
  const drop_part_id = parseIntOrNull(req.params.drop_part_id);
  const drop_id = req.params.drop_id;
  if (drop_part_id === null) {
    throw new NotFoundException(
      `Drop part ${drop_id}/${req.params.drop_part_id} not found`
    );
  }
  await dropsService
    .findDropByIdOrThrow(
      {
        dropId: drop_id
      },
      ctx
    )
    .then((drop) => {
      if (drop.parts.length === 0) {
        throw new NotFoundException(
          `Drop part ${drop_id}/${req.params.drop_part_id} not found`
        );
      }
    });
  const query = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<FullPageRequest<'created_at'> & { drop_type?: ApiDropType }>({
      sort_direction: Joi.string()
        .optional()
        .default(PageSortDirection.DESC)
        .valid(...Object.values(PageSortDirection)),
      sort: Joi.string().optional().default('created_at').valid('created_at'),
      page: Joi.number().integer().min(1).optional().default(1),
      page_size: Joi.number().integer().min(1).max(50).optional().default(20),
      drop_type: Joi.string().optional()
    })
  );
  return { drop_part_id, drop_id, query, drop_type: drop_type_enum };
}

const DropSubscriptionActionsSchema = Joi.object<ApiDropSubscriptionActions>({
  actions: Joi.array()
    .items(
      Joi.string().valid(...Object.values(ApiDropSubscriptionTargetAction))
    )
    .required()
});

export default router;
