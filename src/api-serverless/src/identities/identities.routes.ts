import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiIdentitySubscriptionActions } from '../generated/models/ApiIdentitySubscriptionActions';
import * as Joi from 'joi';
import { ApiIdentitySubscriptionTargetAction } from '../generated/models/ApiIdentitySubscriptionTargetAction';
import { identitiesService } from './identities.service';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { Timer } from '../../../time';
import { WALLET_REGEX } from '@/constants';
import { identityFetcher } from './identity.fetcher';
import { numbers } from '../../../numbers';

const router = asyncRouter();

router.get(
  `/`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        handle: string;
        limit?: string;
        wave_id?: string;
        group_id?: string;
        ignore_authenticated_user?: boolean;
      },
      any
    >,
    res: Response<ApiResponse<ApiIdentity[]>>
  ) {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const handle = (req.query.handle ?? '').trim();
    if (handle.length < 3) {
      throw new BadRequestException(`Handle must be at least 3 characters.`);
    }
    const limit = numbers.parseIntOrNull(req.query.limit) ?? 20;
    if (limit < 1 || limit > 100) {
      throw new BadRequestException(`Limit must be between 1 and 100.`);
    }
    const wave_id = req.query.wave_id ?? null;
    const group_id = req.query.group_id ?? null;
    const profiles = await identitiesService.searchIdentities(
      { handle, limit, wave_id, group_id },
      { authenticationContext, timer }
    );

    if (!req.query.ignore_authenticated_user) {
      res.status(200).send(profiles);
    } else {
      res
        .status(200)
        .send(
          profiles.filter(
            (it) => it.id !== authenticationContext.authenticatedProfileId
          )
        );
    }
  }
);

router.get(
  `/by-wallet/:wallet`,
  async function (
    req: Request<{ wallet: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiIdentity>>
  ) {
    const wallet = req.params.wallet.toLowerCase();
    if (!WALLET_REGEX.test(wallet)) {
      throw new BadRequestException(`Invalid wallet ${wallet}`);
    }
    const identity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: wallet },
        { timer: Timer.getFromRequest(req) }
      );
    if (!identity) {
      throw new NotFoundException(`Identity ${wallet} not found`);
    }
    res.send(identity);
  }
);

router.get(
  `/:identity_key`,
  async function (
    req: Request<{ identity_key: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiIdentity>>
  ) {
    const identityKey = req.params.identity_key.toLowerCase();
    const timer = Timer.getFromRequest(req);
    const identity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        { timer }
      );
    if (!identity) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }
    res.send(identity);
  }
);

router.get(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiIdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const timer = Timer.getFromRequest(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const profileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: req.params.id },
      { authenticationContext, timer }
    );
    const activeActions = !profileId
      ? []
      : ((
          await identityFetcher.getOverviewsByIds([profileId], {
            authenticationContext,
            timer
          })
        )[profileId]?.subscribed_actions ?? []);
    res.send({
      actions: activeActions
    });
  }
);

router.post(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiIdentitySubscriptionActions, any, any>,
    res: Response<ApiResponse<ApiIdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const timer = Timer.getFromRequest(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      IdentintitySubscriptionActionsSchema
    );
    const identityKey = req.params.id;
    const identityAddress = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        { timer, authenticationContext }
      )
      .then((it) => it?.primary_wallet);
    if (!identityAddress) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }
    const activeActions =
      await identitiesService.addIdentitySubscriptionActions({
        identityAddress: identityAddress,
        subscriber: authenticatedProfileId,
        actions: request.actions
      });
    res.send({
      actions: activeActions
    });
  }
);

router.delete(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiIdentitySubscriptionActions, any, any>,
    res: Response<ApiResponse<ApiIdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const timer = Timer.getFromRequest(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      IdentintitySubscriptionActionsSchema
    );
    const identityKey = req.params.id;
    const identityAddress = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey(
        { identityKey },
        { timer, authenticationContext }
      )
      .then((it) => it?.primary_wallet);
    if (!identityAddress) {
      throw new NotFoundException(`Identity ${identityKey} not found`);
    }
    const activeActions =
      await identitiesService.removeIdentitySubscriptionActions({
        identityAddress: identityAddress,
        subscriber: authenticatedProfileId,
        actions: request.actions.filter(
          (it) => it !== ApiIdentitySubscriptionTargetAction.DropVoted
        )
      });
    res.send({
      actions: activeActions
    });
  }
);

const IdentintitySubscriptionActionsSchema =
  Joi.object<ApiIdentitySubscriptionActions>({
    actions: Joi.array()
      .items(
        Joi.string().valid(
          ...Object.values(ApiIdentitySubscriptionTargetAction)
        )
      )
      .required()
  });

export default router;
