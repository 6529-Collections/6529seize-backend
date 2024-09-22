import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
import { IdentitySubscriptionActions } from '../generated/models/IdentitySubscriptionActions';
import * as Joi from 'joi';
import { IdentitySubscriptionTargetAction } from '../generated/models/IdentitySubscriptionTargetAction';
import { identitiesService } from './identities.service';
import { profilesService } from '../../../profiles/profiles.service';
import { profilesApiService } from '../profiles/profiles.api.service';

const router = asyncRouter();

router.get(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<IdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const profileId = await profilesService
      .resolveIdentityOrThrowNotFound(req.params.id)
      .then((it) => it.profile_id);
    const activeActions = !profileId
      ? []
      : (
          await profilesApiService.getProfileMinsByIds({
            ids: [profileId],
            authenticatedProfileId: authenticatedProfileId
          })
        )[profileId]?.subscribed_actions ?? [];
    res.send({
      actions: activeActions
    });
  }
);

router.post(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, IdentitySubscriptionActions, any, any>,
    res: Response<ApiResponse<IdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      IdentintitySubscriptionActionsSchema
    );
    const identityAddress = await profilesService
      .resolveIdentityOrThrowNotFound(req.params.id)
      .then((it) => it.wallet);
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
    req: Request<{ id: string }, any, IdentitySubscriptionActions, any, any>,
    res: Response<ApiResponse<IdentitySubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      IdentintitySubscriptionActionsSchema
    );
    const identityAddress = await profilesService
      .resolveIdentityOrThrowNotFound(req.params.id)
      .then((it) => it.wallet);
    const activeActions =
      await identitiesService.removeIdentitySubscriptionActions({
        identityAddress: identityAddress,
        subscriber: authenticatedProfileId,
        actions: request.actions.filter(
          (it) => it !== IdentitySubscriptionTargetAction.DropVoted
        )
      });
    res.send({
      actions: activeActions
    });
  }
);

const IdentintitySubscriptionActionsSchema =
  Joi.object<IdentitySubscriptionActions>({
    actions: Joi.array()
      .items(
        Joi.string().valid(...Object.values(IdentitySubscriptionTargetAction))
      )
      .required()
  });

export default router;
