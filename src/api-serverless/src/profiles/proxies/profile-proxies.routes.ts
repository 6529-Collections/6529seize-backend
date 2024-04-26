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
import { ProfileProxyEntity } from '../../../../entities/IProfileProxy';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../../validation';
import { profileProxyApiService } from '../../proxies/proxy.api.service';
import { profilesService } from '../../../../profiles/profiles.service';
import { BadRequestException } from '../../../../exceptions';
import {
  getAuthenticatedWalletOrNull,
  maybeAuthenticatedUser
} from '../../auth/auth';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/received',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      ProfileReceivedProfileProxiesQuery,
      any
    >,

    res: Response<ApiResponse<Page<ProfileProxyEntity>>>
  ) => {
    // fix any
    const maybeAuthenticatedWallet = getAuthenticatedWalletOrNull(req as any);
    const maybeAuthenticatedProfile =
      maybeAuthenticatedWallet
        ? await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            maybeAuthenticatedWallet
          )
        : null;

    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        req.params.handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new BadRequestException(
        `Profile with id ${req.params.handleOrWallet} does not exist`
      );
    }

    const isRequesterTarget =
      maybeAuthenticatedProfile?.profile?.external_id ===
      targetProfile.profile?.external_id;

    console.log('isRequesterTarget', isRequesterTarget);

    const unvalidatedQuery = req.query;
    const query = getValidatedByJoiOrThrow(
      unvalidatedQuery,
      ProfileReceivedProfileProxiesQuerySchema
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

export interface ProfileReceivedProfileProxiesQuery
  extends FullPageRequest<ProfileReceivedProfileProxiesQuerySortOptions> {}

export enum ProfileReceivedProfileProxiesQuerySortOptions {
  CREATED_AT = 'created_at'
}

const ProfileReceivedProfileProxiesQuerySchema =
  Joi.object<ProfileReceivedProfileProxiesQuery>({
    sort_direction: Joi.string()
      .optional()
      .default(PageSortDirection.DESC)
      .valid(...Object.values(PageSortDirection))
      .allow(null),
    sort: Joi.string()
      .optional()
      .default(ProfileReceivedProfileProxiesQuerySortOptions.CREATED_AT)
      .valid(...Object.values(ProfileReceivedProfileProxiesQuerySortOptions))
      .allow(null),
    page: Joi.number().integer().min(1).optional().allow(null).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .allow(null)
      .default(DEFAULT_PAGE_SIZE)
  });

export default router;
