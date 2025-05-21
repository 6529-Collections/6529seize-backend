import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { ApiCreateNewProfileProxy } from '../generated/models/ApiCreateNewProfileProxy';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { profileProxyApiService } from './proxy.api.service';
import { BadRequestException } from '../../../exceptions';
import { ProxyApiRequestAction } from './proxies.api.types';
import { ApiCreateNewProfileProxyAllocateRepAction } from '../generated/models/ApiCreateNewProfileProxyAllocateRepAction';
import { ApiCreateNewProfileProxyAllocateCicAction } from '../generated/models/ApiCreateNewProfileProxyAllocateCicAction';
import { ApiCreateNewProfileProxyCreateWaveAction } from '../generated/models/ApiCreateNewProfileProxyCreateWaveAction';
import { ApiCreateNewProfileProxyReadWaveAction } from '../generated/models/ApiCreateNewProfileProxyReadWaveAction';
import { ApiProfileProxyActionType } from '../generated/models/ApiProfileProxyActionType';
import { ApiCreateNewProfileProxyRateWaveDropAction } from '../generated/models/ApiCreateNewProfileProxyRateWaveDropAction';
import { assertUnreachable } from '../../../assertions';
import { ApiProfileProxy } from '../generated/models/ApiProfileProxy';
import {
  AcceptActionRequest,
  AcceptActionRequestActionEnum
} from '../generated/models/AcceptActionRequest';
import { ProfileProxyActionEntity } from '../../../entities/IProfileProxyAction';
import { ApiUpdateProxyActionRequest } from '../generated/models/ApiUpdateProxyActionRequest';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateNewProfileProxy, any, any>,
    res: Response<ApiResponse<ApiProfileProxy>>
  ) => {
    const { body } = req;
    const newProxy = getValidatedByJoiOrThrow(body, NewProfileProxySchema);
    const grantorProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: getWalletOrThrow(req) },
      { timer: Timer.getFromRequest(req) }
    );
    if (!grantorProfileId) {
      throw new BadRequestException(
        'You need to create a profile before you can manage a proxy'
      );
    }

    if (grantorProfileId.toLowerCase() === newProxy.target_id.toLowerCase()) {
      throw new BadRequestException('You cannot create a proxy to yourself');
    }

    const profileProxy = await profileProxyApiService.createProfileProxy({
      params: newProxy,
      grantorProfileId
    });

    res.send(profileProxy);
  }
);

router.get(
  '/:proxy_id',
  async (
    req: Request<{ proxy_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiProfileProxy>>
  ) => {
    const { proxy_id } = req.params;
    const profileProxy =
      await profileProxyApiService.getProfileProxyByIdOrThrow({
        proxy_id
      });
    res.send(profileProxy);
  }
);

router.post(
  '/:proxy_id/actions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ proxy_id: string }, any, ProxyApiRequestAction, any, any>,
    res: Response<ApiResponse<ProfileProxyActionEntity>>
  ) => {
    const { proxy_id } = req.params;
    const requesterProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: getWalletOrThrow(req) },
      { timer: Timer.getFromRequest(req) }
    );
    if (!requesterProfileId) {
      throw new BadRequestException(
        'You need to create a profile before you can create a proxy'
      );
    }
    const profileProxy =
      await profileProxyApiService.getProfileProxyByIdOrThrow({
        proxy_id
      });

    if (profileProxy.created_by.id !== requesterProfileId) {
      throw new BadRequestException('You are not the creator of this proxy');
    }

    if (!req.body.action_type) {
      throw new BadRequestException('Action type is required');
    }
    const type = req.body.action_type;
    switch (type) {
      case ApiProfileProxyActionType.AllocateRep:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyAllocateRepActionSchema
        );
        break;
      case ApiProfileProxyActionType.AllocateCic:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyAllocateCicActionSchema
        );
        break;
      case ApiProfileProxyActionType.CreateWave:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyCreateWaveActionSchema
        );
        break;
      case ApiProfileProxyActionType.ReadWave:
        getValidatedByJoiOrThrow(req.body, NewProfileProxyReadWaveActionSchema);
        break;
      case ApiProfileProxyActionType.CreateDropToWave:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyCreateDropToWaveActionSchema
        );
        break;
      case ApiProfileProxyActionType.RateWaveDrop:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyRateWaveDropActionSchema
        );
        break;
      default:
        assertUnreachable(type);
        throw new BadRequestException('Invalid action type');
    }

    const action = await profileProxyApiService.createProfileProxyAction({
      proxy: profileProxy,
      action: req.body
    });

    res.send(action);
  }
);

router.post(
  '/:proxy_id/actions/:action_id/acceptance',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { proxy_id: string; action_id: string },
      any,
      AcceptActionRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ProfileProxyActionEntity>>
  ) => {
    const { proxy_id, action_id } = req.params;
    const requesterProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: getWalletOrThrow(req) },
      { timer: Timer.getFromRequest(req) }
    );
    if (!requesterProfileId) {
      throw new BadRequestException(
        'You need to create a profile before you can manage a proxy'
      );
    }
    const validRequest = getValidatedByJoiOrThrow(
      req.body,
      AcceptActionRequestSchema
    );
    const action = await profileProxyApiService.changeProfileProxyActionStatus({
      proxy_id,
      action_id,
      acceptance_type: validRequest.action,
      profile_id: requesterProfileId
    });

    res.send(action);
  }
);

router.put(
  '/:proxy_id/actions/:action_id',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { proxy_id: string; action_id: string },
      any,
      ApiUpdateProxyActionRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ProfileProxyActionEntity>>
  ) => {
    const { proxy_id, action_id } = req.params;
    const requesterProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: getWalletOrThrow(req) },
      { timer: Timer.getFromRequest(req) }
    );
    if (!requesterProfileId) {
      throw new BadRequestException(
        'You need to create a profile before you can manage a proxy'
      );
    }
    const validRequest = getValidatedByJoiOrThrow(
      req.body,
      UpdateActionRequestSchema
    );
    const action = await profileProxyApiService.updateProfileProxyAction({
      proxy_id,
      action_id,
      credit_amount: validRequest.credit_amount,
      end_time: validRequest.end_time,
      profile_id: requesterProfileId
    });

    res.send(action);
  }
);

const NewProfileProxySchema = Joi.object<ApiCreateNewProfileProxy>({
  target_id: Joi.string().required()
});

const NewProfileProxyAllocateRepActionSchema =
  Joi.object<ApiCreateNewProfileProxyAllocateRepAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.AllocateRep)
      .required(),
    end_time: Joi.number().optional().allow(null),
    credit_amount: Joi.number().min(1).required()
  });

const NewProfileProxyAllocateCicActionSchema =
  Joi.object<ApiCreateNewProfileProxyAllocateCicAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.AllocateCic)
      .required(),
    end_time: Joi.number().optional().allow(null),
    credit_amount: Joi.number().min(1).required()
  });

const NewProfileProxyCreateWaveActionSchema =
  Joi.object<ApiCreateNewProfileProxyCreateWaveAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.CreateWave)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyReadWaveActionSchema =
  Joi.object<ApiCreateNewProfileProxyReadWaveAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.ReadWave)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyCreateDropToWaveActionSchema =
  Joi.object<ApiCreateNewProfileProxyCreateWaveAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.CreateDropToWave)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyRateWaveDropActionSchema =
  Joi.object<ApiCreateNewProfileProxyRateWaveDropAction>({
    action_type: Joi.string()
      .valid(ApiProfileProxyActionType.RateWaveDrop)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const AcceptActionRequestSchema = Joi.object<AcceptActionRequest>({
  action: Joi.string()
    .required()
    .allow(...Object.values(AcceptActionRequestActionEnum))
});

const UpdateActionRequestSchema = Joi.object<ApiUpdateProxyActionRequest>({
  end_time: Joi.number().optional().allow(null),
  credit_amount: Joi.number().optional()
});
export default router;
