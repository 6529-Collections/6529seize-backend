import { asyncRouter } from '../../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../../api-response';
import { getValidatedByJoiOrThrow } from '../../validation';
import { ApiXTdhCreateGrantSchema } from './xtdh-grants.validator';
import { ForbiddenException } from '../../../../exceptions';
import { Time, Timer } from '../../../../time';
import { createXTdhGrantUseCase } from '../../../../xtdh-grants/create-xtdh-grant.use-case';
import { xTdhGrantApiConverter } from './xtdh-grant.api-converter';
import { appFeatures } from '../../../../app-features';
import {
  ApiXTdhGrantUpdateRequestSchema,
  XTdhGrantSearchRequestApiModel,
  XTdhGrantSearchRequestApiModelSchema,
  XTdhGrantTokensSearchRequestApiModel,
  XTdhGrantTokensSearchRequestApiModelSchema
} from './xtdh-grant-search-request.api-model';
import { RequestContext } from '../../../../request.context';
import { xTdhGrantsFinder } from '../../../../xtdh-grants/xtdh-grants.finder';
import { ApiXTdhGrantsPage } from '../../generated/models/ApiXTdhGrantsPage';
import { ApiXTdhGrant } from '../../generated/models/ApiXTdhGrant';
import { ApiXTdhGrantUpdateRequest } from '../../generated/models/ApiXTdhGrantUpdateRequest';
import { ApiXTdhGrantTokensPage } from '../../generated/models/ApiXTdhGrantTokensPage';
import { ApiXTdhCreateGrant } from '../../generated/models/ApiXTdhCreateGrant';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, XTdhGrantSearchRequestApiModel, any>,
    res: Response<ApiResponse<ApiXTdhGrantsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const searchRequestApiModel = getValidatedByJoiOrThrow(
      req.query,
      XTdhGrantSearchRequestApiModelSchema
    );
    const searchModel = await xTdhGrantApiConverter.prepApiSearchRequest(
      searchRequestApiModel,
      ctx
    );
    const results = await xTdhGrantsFinder.searchForPage(searchModel, ctx);
    const apiItems =
      await xTdhGrantApiConverter.fromXTdhGrantModelsToApiXTdhGrants(
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
    res: Response<ApiResponse<ApiXTdhGrant>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const grantId = req.params.id;
    const grantModel = await xTdhGrantsFinder.getGrantByIdOrThrow(grantId, ctx);
    const grant = await xTdhGrantApiConverter.fromXTdhGrantModelToApiXTdhGrant(
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
    req: Request<{ id: string }, any, ApiXTdhGrantUpdateRequest, any, any>,
    res: Response<ApiResponse<ApiXTdhGrant>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const grantId = req.params.id;
    const { valid_to } = getValidatedByJoiOrThrow(
      req.body,
      ApiXTdhGrantUpdateRequestSchema
    );
    const updatedGrantModel = await xTdhGrantsFinder.updateXTdhGrant(
      { grantId, proposedValidTo: valid_to ? Time.millis(valid_to) : null },
      ctx
    );
    const updatedGrant =
      await xTdhGrantApiConverter.fromXTdhGrantModelToApiXTdhGrant(
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
      XTdhGrantTokensSearchRequestApiModel,
      any
    >,
    res: Response<ApiResponse<ApiXTdhGrantTokensPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const searchModel = getValidatedByJoiOrThrow(
      { ...req.query, grant_id: req.params.id },
      XTdhGrantTokensSearchRequestApiModelSchema
    );
    const results = await xTdhGrantsFinder.searchForTokens(searchModel, ctx);
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
    req: Request<any, any, ApiXTdhCreateGrant, any, any>,
    res: Response<ApiResponse<ApiXTdhGrant>>
  ) => {
    if (!appFeatures.isXTdhEnabled()) {
      throw new ForbiddenException(
        `This endpoint is part of an ongoing development and is not yet enabled`
      );
    }
    const apiCreateXTdhGrant = getValidatedByJoiOrThrow(
      req.body,
      ApiXTdhCreateGrantSchema
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
      throw new ForbiddenException(`Proxies can't create xTDH grants`);
    }

    const createCommand = xTdhGrantApiConverter.fromApiCreateXTdhGrantToModel({
      apiCreateXTdhGrant,
      grantorId
    });
    const model = await createXTdhGrantUseCase.handle(createCommand, {
      timer
    });
    const apiResponse =
      await xTdhGrantApiConverter.fromXTdhGrantModelToApiXTdhGrant(model, {
        authenticationContext,
        timer
      });
    res.send(apiResponse);
  }
);

export default router;
