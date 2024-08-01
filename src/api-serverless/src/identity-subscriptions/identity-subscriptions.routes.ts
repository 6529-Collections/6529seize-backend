import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { ActivityEventTargetType } from '../../../entities/IActivityEvent';
import * as Joi from 'joi';
import { OutgoingIdentitySubscriptionsPage } from '../generated/models/OutgoingIdentitySubscriptionsPage';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { identitySubscriptionsApiService } from './identity-subscriptions.api.service';
import { IncomingIdentitySubscriptionsPage } from '../generated/models/IncomingIdentitySubscriptionsPage';
import { profilesService } from '../../../profiles/profiles.service';

const router = asyncRouter();

router.get(
  '/outgoing/:target_type',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { target_type: ActivityEventTargetType },
      any,
      any,
      { page: number; page_size: number },
      any
    >,
    res: Response<ApiResponse<OutgoingIdentitySubscriptionsPage>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedUsedId = authenticationContext.getActingAsId();
    if (!authenticatedUsedId) {
      throw new ForbiddenException(
        `Create a profile before using this service`
      );
    }
    const params = getValidatedByJoiOrThrow(
      { ...req.params, ...req.query, subscriber_id: authenticatedUsedId },
      OutgoingIdentitySubscriptionsParamsSchema
    );
    const response =
      await identitySubscriptionsApiService.findOutgoingSubscriptionsOfType(
        params,
        authenticationContext
      );
    res.send(response);
  }
);

router.get(
  '/incoming/:target_type/:target_id',
  async (
    req: Request<
      { target_type: ActivityEventTargetType; target_id: string },
      any,
      any,
      { page: number; page_size: number },
      any
    >,
    res: Response<ApiResponse<IncomingIdentitySubscriptionsPage>>
  ) => {
    let targetId: string | null = req.params.target_id;
    if (req.params.target_type === ActivityEventTargetType.IDENTITY) {
      targetId = await profilesService
        .resolveIdentityOrThrowNotFound(targetId)
        .then((it) => it.profile_id);
      if (!targetId) {
        throw new NotFoundException(`Identity not found`);
      }
    }
    const params = getValidatedByJoiOrThrow(
      {
        target_type: req.params.target_type,
        target_id: targetId,
        ...req.query
      },
      IncomingIdentitySubscriptionsParamsSchema
    );
    const response =
      await identitySubscriptionsApiService.findIncomingSubscriptionsOfType(
        params
      );
    res.send(response);
  }
);

export interface IncomingIdentitySubscriptionsParams {
  readonly page: number;
  readonly page_size: number;
  readonly target_id: string;
  readonly target_type: ActivityEventTargetType;
}

export interface OutgoingIdentitySubscriptionsParams {
  readonly page: number;
  readonly page_size: number;
  readonly subscriber_id: string;
  readonly target_type: ActivityEventTargetType;
}

export const IncomingIdentitySubscriptionsParamsSchema =
  Joi.object<IncomingIdentitySubscriptionsParams>({
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(10),
    target_id: Joi.string().required(),
    target_type: Joi.string()
      .allow(...Object.values(ActivityEventTargetType))
      .required()
  });

export const OutgoingIdentitySubscriptionsParamsSchema =
  Joi.object<OutgoingIdentitySubscriptionsParams>({
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(10),
    subscriber_id: Joi.string().required(),
    target_type: Joi.string()
      .allow(...Object.values(ActivityEventTargetType))
      .required()
  });

export default router;
