import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { ApiResponse } from '../api-response';
import { CreateNewProfileProxy } from '../generated/models/CreateNewProfileProxy';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { profilesService } from '../../../profiles/profiles.service';
import { profileProxyApiService } from './proxy.api.service';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { ProxyApiRequestAction } from './proxies.api.types';
import { CreateNewProfileProxyAllocateRepAction } from '../generated/models/CreateNewProfileProxyAllocateRepAction';
import { CreateNewProfileProxyAllocateCicAction } from '../generated/models/CreateNewProfileProxyAllocateCicAction';
import { CreateNewProfileProxyCreateWaveAction } from '../generated/models/CreateNewProfileProxyCreateWaveAction';
import { CreateNewProfileProxyReadWaveAction } from '../generated/models/CreateNewProfileProxyReadWaveAction';
import { ProfileProxyActionType } from '../generated/models/ProfileProxyActionType';
import { CreateNewProfileProxyRateWaveDropAction } from '../generated/models/CreateNewProfileProxyRateWaveDropAction';
import { assertUnreachable } from '../../../helpers';
import { ProfileProxy } from '../generated/models/ProfileProxy';
import {
  AcceptActionRequest,
  AcceptActionRequestActionEnum
} from '../generated/models/AcceptActionRequest';
import { ProfileProxyActionEntity } from '../../../entities/IProfileProxyAction';
import { UpdateProxyActionRequest } from '../generated/models/UpdateProxyActionRequest';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateNewProfileProxy, any, any>,
    res: Response<ApiResponse<ProfileProxy>>
  ) => {
    const { body } = req;
    const newProxy = getValidatedByJoiOrThrow(body, NewProfileProxySchema);
    const grantorProfile = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      ?.then((result) => result?.profile ?? null);
    if (!grantorProfile) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a proxy'
      );
    }

    if (
      grantorProfile.external_id.toLowerCase() ===
      newProxy.target_id.toLowerCase()
    ) {
      throw new BadRequestException('You cannot create a proxy to yourself');
    }

    const profileProxy = await profileProxyApiService.createProfileProxy({
      params: newProxy,
      grantorProfile
    });

    res.send(profileProxy);
  }
);

router.get(
  '/:proxy_id',
  async (
    req: Request<{ proxy_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ProfileProxy>>
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
    const requesterProfile = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      ?.then((result) => result?.profile ?? null);
    if (!requesterProfile) {
      throw new BadRequestException(
        'You need to create a profile before you can create a proxy'
      );
    }
    const profileProxy =
      await profileProxyApiService.getProfileProxyByIdOrThrow({
        proxy_id
      });

    if (profileProxy.created_by.id !== requesterProfile.external_id) {
      throw new BadRequestException('You are not the creator of this proxy');
    }

    if (!req.body.action_type) {
      throw new BadRequestException('Action type is required');
    }
    const type = req.body.action_type;
    switch (type) {
      case ProfileProxyActionType.AllocateRep:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyAllocateRepActionSchema
        );
        break;
      case ProfileProxyActionType.AllocateCic:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyAllocateCicActionSchema
        );
        break;
      case ProfileProxyActionType.CreateWave:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyCreateWaveActionSchema
        );
        break;
      case ProfileProxyActionType.ReadWave:
        getValidatedByJoiOrThrow(req.body, NewProfileProxyReadWaveActionSchema);
        break;
      case ProfileProxyActionType.CreateDropToWave:
        getValidatedByJoiOrThrow(
          req.body,
          NewProfileProxyCreateDropToWaveActionSchema
        );
        break;
      case ProfileProxyActionType.RateWaveDrop:
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
    const requesterProfile = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      ?.then((result) => result?.profile ?? null);
    if (!requesterProfile) {
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
      profile_id: requesterProfile.external_id
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
      UpdateProxyActionRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ProfileProxyActionEntity>>
  ) => {
    const { proxy_id, action_id } = req.params;
    const requesterProfile = await profilesService
      .getProfileAndConsolidationsByIdentity(getWalletOrThrow(req))
      ?.then((result) => result?.profile ?? null);
    if (!requesterProfile) {
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
      profile_id: requesterProfile.external_id
    });

    res.send(action);
  }
);

const NewProfileProxySchema = Joi.object<CreateNewProfileProxy>({
  target_id: Joi.string().required()
});

const NewProfileProxyAllocateRepActionSchema =
  Joi.object<CreateNewProfileProxyAllocateRepAction>({
    action_type: Joi.string()
      .valid(ProfileProxyActionType.AllocateRep)
      .required(),
    end_time: Joi.number().optional().allow(null),
    credit_amount: Joi.number().min(1).required()
  });

const NewProfileProxyAllocateCicActionSchema =
  Joi.object<CreateNewProfileProxyAllocateCicAction>({
    action_type: Joi.string()
      .valid(ProfileProxyActionType.AllocateCic)
      .required(),
    end_time: Joi.number().optional().allow(null),
    credit_amount: Joi.number().min(1).required()
  });

const NewProfileProxyCreateWaveActionSchema =
  Joi.object<CreateNewProfileProxyCreateWaveAction>({
    action_type: Joi.string()
      .valid(ProfileProxyActionType.CreateWave)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyReadWaveActionSchema =
  Joi.object<CreateNewProfileProxyReadWaveAction>({
    action_type: Joi.string().valid(ProfileProxyActionType.ReadWave).required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyCreateDropToWaveActionSchema =
  Joi.object<CreateNewProfileProxyCreateWaveAction>({
    action_type: Joi.string()
      .valid(ProfileProxyActionType.CreateDropToWave)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const NewProfileProxyRateWaveDropActionSchema =
  Joi.object<CreateNewProfileProxyRateWaveDropAction>({
    action_type: Joi.string()
      .valid(ProfileProxyActionType.RateWaveDrop)
      .required(),
    end_time: Joi.number().optional().allow(null)
  });

const AcceptActionRequestSchema = Joi.object<AcceptActionRequest>({
  action: Joi.string()
    .required()
    .allow(...Object.values(AcceptActionRequestActionEnum))
});

const UpdateActionRequestSchema = Joi.object<UpdateProxyActionRequest>({
  end_time: Joi.number().optional().allow(null),
  credit_amount: Joi.number().optional()
});
export default router;
