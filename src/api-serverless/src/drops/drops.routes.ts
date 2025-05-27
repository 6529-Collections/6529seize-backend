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
import { dropCheeringService } from './drop-cheering.service';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { userGroupsService } from '../community-members/user-groups.service';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  ApiAddRatingToDropRequest,
  ApiAddRatingToDropRequestSchema,
  ApiAddReactionToDropRequest,
  ApiAddReactionToDropRequestSchema,
  NewDropSchema,
  UpdateDropSchema
} from './drop.validator';
import { ApiDropSubscriptionActions } from '../generated/models/ApiDropSubscriptionActions';
import { ApiDropSubscriptionTargetAction } from '../generated/models/ApiDropSubscriptionTargetAction';
import { Timer } from '../../../time';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import { ApiDropType } from '../generated/models/ApiDropType';
import { wavesApiDb } from '../waves/waves.api.db';
import { dropSignatureVerifier } from './drop-signature-verifier';
import { dropsDb } from '../../../drops/drops.db';
import { identityFetcher } from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { numbers } from '../../../numbers';
import { dropReactionsService } from './reactions/drop-reactions.service';

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
        serial_no_less_than: numbers.parseIntOrNull(
          req.query.serial_no_less_than
        ),
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
    await assertDropIsCorrectlySigned(apiRequest, authorProfileId);
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
      reply_to: newDrop.reply_to,
      drop_type: newDrop.drop_type,
      mentions_all: newDrop.mentions_all,
      signature: newDrop.signature
    };
    const createdDrop = await dropCreationService.createDrop(
      {
        createDropRequest,
        authorId: authorProfileId,
        representativeId: authenticationContext.isAuthenticatedAsProxy()
          ? authenticationContext.roleProfileId!
          : authorProfileId
      },
      { timer, authenticationContext }
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
    const dropId = req.params.drop_id;
    const apiRequest = req.body;
    const updateRequest: ApiUpdateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      UpdateDropSchema
    );
    const authorId = authenticationContext.getActingAsId()!;
    const waveId = await dropsDb.findWaveIdByDropId(dropId, { timer });
    if (!waveId) {
      throw new NotFoundException(`Could not find drop ${dropId}'s wave`);
    }
    await assertDropIsCorrectlySigned(
      {
        ...apiRequest,
        wave_id: waveId
      },
      authorId
    );
    const updatedDrop = await dropCreationService.updateDrop(
      {
        dropId: dropId,
        request: updateRequest,
        authorId: authorId,
        representativeId: authenticationContext.getLoggedInUsersProfileId()!
      },
      { timer, authenticationContext }
    );
    res.send(updatedDrop);
  }
);

router.delete(
  '/:drop_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
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
    res.send({});
  }
);

router.post(
  `/:drop_id/ratings`,
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, ApiAddRatingToDropRequest, any, any>,
    res: Response<ApiResponse<ApiDrop>>
  ) => {
    const { rating } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRatingToDropRequestSchema
    );
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
      );
    }
    const dropId = req.params.drop_id;
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
    await dropCheeringService.updateCheers(
      {
        rater_profile_id: raterProfileId,
        groupIdsUserIsEligibleFor: group_ids_user_is_eligible_for,
        drop_id: dropId,
        cheersChange: rating
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

router
  .route(`/:drop_id/reaction`)
  .all(needsAuthenticatedUser())
  .post(dropReactionsService.reactionHandler(false))
  .delete(dropReactionsService.reactionHandler(true));

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
  const limit = numbers.parseIntOrNull(req.query.limit) ?? 10;
  const wave_id = req.query.wave_id ?? null;
  const group_id = req.query.group_id ?? null;
  const include_replies = req.query.include_replies === 'true';
  const drop_type_str = (req.query.drop_type as string) ?? null;
  const drop_type_enum = enums.resolve(ApiDropType, drop_type_str) ?? null;
  const author_id = req.query.author
    ? await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: req.query.author },
        { timer: Timer.getFromRequest(req) }
      )
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

const DropSubscriptionActionsSchema = Joi.object<ApiDropSubscriptionActions>({
  actions: Joi.array()
    .items(
      Joi.string().valid(...Object.values(ApiDropSubscriptionTargetAction))
    )
    .required()
});

async function assertDropIsCorrectlySigned(
  drop: ApiCreateDropRequest,
  authorProfileId: string
) {
  if (drop.drop_type === ApiDropType.Participatory) {
    const waveEntity = await wavesApiDb.findWaveById(drop.wave_id);
    if (!waveEntity) {
      throw new NotFoundException(`Wave ${drop.wave_id} does not exist`);
    }
    const isSignatureRequired = waveEntity.participation_signature_required;
    if (isSignatureRequired) {
      const signature = drop.signature;
      if (!signature) {
        throw new BadRequestException(`Drop is missing a signature`);
      }
      const wallets = await identityFetcher
        .getIdentityAndConsolidationsByIdentityKey(
          {
            identityKey: authorProfileId
          },
          {}
        )
        .then((it) => it?.wallets?.map((w) => w.wallet) ?? []);
      const isDropCorrectlySigned =
        dropSignatureVerifier.isDropSignedByAnyOfGivenWallets({
          wallets,
          drop: drop,
          termsOfService: waveEntity.participation_terms
        });
      if (!isDropCorrectlySigned) {
        throw new BadRequestException(`Invalid drop signature`);
      }
    }
  }
}

export default router;
