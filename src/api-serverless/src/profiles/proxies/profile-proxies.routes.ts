import { Request, Response } from 'express';
import { asyncRouter } from '../../async.router';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  FullPageRequest,
  Page,
  PageSortDirection
} from '../../page-request';
import { ApiResponse } from '../../api-response';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../../validation';
import { profileProxyApiService } from '../../proxies/proxy.api.service';
import { profilesService } from '../../../../profiles/profiles.service';
import { BadRequestException } from '../../../../exceptions';
import { ProfileProxy } from '../../generated/models/ProfileProxy';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/received',
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      ProfileProfileProxiesQuery,
      any
    >,

    res: Response<ApiResponse<Page<ProfileProxy>>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        req.params.handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new BadRequestException(
        `Profile with id ${req.params.handleOrWallet} does not exist`
      );
    }

    const unvalidatedQuery = req.query;
    const query = getValidatedByJoiOrThrow(
      unvalidatedQuery,
      ProfileProfileProxiesQuerySchema
    );

    // make new interface what returns also actions and ProfileMin's, if target is not requester, return only active actions, return only (both cases) where there is at least 1 action after filter
    const result =
      await profileProxyApiService.getProfileReceivedProfileProxies({
        target_id: targetProfile.profile.external_id,
        ...query
      });
    res.send(result);
  }
);

router.get(
  '/granted',
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      ProfileProfileProxiesQuery,
      any
    >,

    res: Response<ApiResponse<Page<ProfileProxy>>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        req.params.handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new BadRequestException(
        `Profile with id ${req.params.handleOrWallet} does not exist`
      );
    }

    const unvalidatedQuery = req.query;
    const query = getValidatedByJoiOrThrow(
      unvalidatedQuery,
      ProfileProfileProxiesQuerySchema
    );

    // make new interface what returns also actions and ProfileMin's, if target is not requester, return only active actions, return only (both cases) where there is at least 1 action after filter
    const result = await profileProxyApiService.getProfileGrantedProfileProxies(
      {
        created_by: targetProfile.profile.external_id,
        ...query
      }
    );
    res.send(result);
  }
);

export enum ProfileProfileProxiesQuerySortOptions {
  CREATED_AT = 'created_at'
}

export type ProfileProfileProxiesQuery =
  FullPageRequest<ProfileProfileProxiesQuerySortOptions>;

const ProfileProfileProxiesQuerySchema = Joi.object<ProfileProfileProxiesQuery>(
  {
    sort_direction: Joi.string()
      .optional()
      .default(PageSortDirection.DESC)
      .valid(...Object.values(PageSortDirection))
      .allow(null),
    sort: Joi.string()
      .optional()
      .default(ProfileProfileProxiesQuerySortOptions.CREATED_AT)
      .valid(...Object.values(ProfileProfileProxiesQuerySortOptions))
      .allow(null),
    page: Joi.number().integer().min(1).optional().allow(null).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .allow(null)
      .default(DEFAULT_PAGE_SIZE)
  }
);

export default router;
