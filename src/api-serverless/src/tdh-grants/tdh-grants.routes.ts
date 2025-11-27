import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ApiCreateTdhGrant } from '../generated/models/ApiCreateTdhGrant';
import { ApiTdhGrant } from '../generated/models/ApiTdhGrant';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiCreateTdhGrantSchema } from './tdh-grants.validator';
import { ForbiddenException } from '../../../exceptions';
import { Time, Timer } from '../../../time';
import { createTdhGrantUseCase } from '../../../tdh-grants/create-tdh-grant.use-case';
import { tdhGrantApiConverter } from './tdh-grant.api-converter';
import { appFeatures } from '../../../app-features';
import { ApiTdhGrantsPage } from '../generated/models/ApiTdhGrantsPage';
import {
  ApiTdhGrantUpdateRequestSchema,
  TdhGrantSearchRequestApiModel,
  TdhGrantSearchRequestApiModelSchema,
  TdhGrantTokensSearchRequestApiModel,
  TdhGrantTokensSearchRequestApiModelSchema
} from './tdh-grant-search-request.api-model';
import { RequestContext } from '../../../request.context';
import { tdhGrantsFinder } from '../../../tdh-grants/tdh-grants.finder';
import { ApiTdhGrantTokensPage } from '../generated/models/ApiTdhGrantTokensPage';
import { ApiTdhGrantUpdateRequest } from '../generated/models/ApiTdhGrantUpdateRequest';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, TdhGrantSearchRequestApiModel, any>,
    res: Response<ApiResponse<ApiTdhGrantsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const tdhGrantSearchRequestApiModel = getValidatedByJoiOrThrow(
      req.query,
      TdhGrantSearchRequestApiModelSchema
    );
    const searchModel = await tdhGrantApiConverter.prepApiSearchRequest(
      tdhGrantSearchRequestApiModel,
      ctx
    );
    const results = await tdhGrantsFinder.searchForPage(searchModel, ctx);
    const apiItems =
      await tdhGrantApiConverter.fromTdhGrantModelsToApiTdhGrants(
        results.items,
        ctx
      );
    res.send({
      count: results.count,
      page: results.page,
      next: results.next,
      data: apiItems
    });
  }
);

router.get(
  '/:id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiTdhGrant>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const grantId = req.params.id;
    const grantModel = await tdhGrantsFinder.getGrantByIdOrThrow(grantId, ctx);
    const grant = await tdhGrantApiConverter.fromTdhGrantModelToApiTdhGrant(
      grantModel,
      ctx
    );
    res.send(grant);
  }
);

router.post(
  '/:id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiTdhGrantUpdateRequest, any, any>,
    res: Response<ApiResponse<ApiTdhGrant>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const grantId = req.params.id;
    const { valid_to } = getValidatedByJoiOrThrow(
      req.body,
      ApiTdhGrantUpdateRequestSchema
    );
    const updatedGrantModel = await tdhGrantsFinder.updateTdhGrant(
      { grantId, proposedValidTo: valid_to ? Time.millis(valid_to) : null },
      ctx
    );
    const updatedGrant =
      await tdhGrantApiConverter.fromTdhGrantModelToApiTdhGrant(
        updatedGrantModel,
        ctx
      );
    res.send(updatedGrant);
  }
);

router.get(
  '/:id/tokens',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      TdhGrantTokensSearchRequestApiModel,
      any
    >,
    res: Response<ApiResponse<ApiTdhGrantTokensPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const searchModel = getValidatedByJoiOrThrow(
      { ...req.query, grant_id: req.params.id },
      TdhGrantTokensSearchRequestApiModelSchema
    );
    const results = await tdhGrantsFinder.searchForTokens(searchModel, ctx);
    const data = results.items.map((token) => ({ token }));
    res.send({
      count: results.count,
      page: results.page,
      next: results.next,
      data
    });
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateTdhGrant, any, any>,
    res: Response<ApiResponse<ApiTdhGrant>>
  ) => {
    if (!appFeatures.isXTdhEnabled()) {
      throw new ForbiddenException(
        `This endpoint is part of an ongoing development and is not yet enabled`
      );
    }
    const apiCreateTdhGrant = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateTdhGrantSchema
    );
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const grantorId = authenticationContext.getActingAsId();
    if (!grantorId) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't create TDH grants`);
    }

    const createCommand = tdhGrantApiConverter.fromApiCreateTdhGrantToModel({
      apiCreateTdhGrant,
      grantorId
    });
    const model = await createTdhGrantUseCase.handle(createCommand, {
      timer
    });
    const apiResponse =
      await tdhGrantApiConverter.fromTdhGrantModelToApiTdhGrant(model, {
        authenticationContext,
        timer
      });
    res.send(apiResponse);
  }
);

export default router;
