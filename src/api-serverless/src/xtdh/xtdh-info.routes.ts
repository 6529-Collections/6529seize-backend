import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import * as Joi from 'joi';
import { ApiXTdhTokensPage } from '../generated/models/ApiXTdhTokensPage';
import { xtdhInfoService } from './xtdh-info.service';
import { ApiContract } from '../generated/models/ApiContract';
import { ApiXTdhTokenGrantor } from '../generated/models/ApiXTdhTokenGrantor';

interface SearchParams {
  grantee: string | null;
  contract: string | null;
  token: string | null;
  page: number;
  page_size: number;
}

const SearchParamsSchema: Joi.ObjectSchema<SearchParams> =
  Joi.object<SearchParams>({
    grantee: Joi.string().optional().default(null),
    contract: Joi.string().optional().default(null),
    token: Joi.string().optional().default(null),
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(20)
  });

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, SearchParams, any>,
    res: Response<ApiResponse<ApiXTdhTokensPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const searchParams = getValidatedByJoiOrThrow(
      req.query,
      SearchParamsSchema
    );

    const { tokens, next } = await xtdhInfoService.getXTdhTokens(
      searchParams,
      ctx
    );

    res.send({
      page: searchParams.page,
      next,
      data: tokens
    });
  }
);

router.get(
  '/identity/:identity/contracts',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiContract[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const identity = req.params.identity;

    const results =
      await xtdhInfoService.getContractsBaseOnWhichIdentityHasXTdh(
        identity,
        ctx
      );
    res.send(results);
  }
);

router.get(
  '/contract/:contract/token/:token/contributors',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ contract: string; token: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiXTdhTokenGrantor[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const { contract, token } = req.params;

    const result = await xtdhInfoService.getTokenXTdhContributors(
      { contract, token },
      ctx
    );
    res.send(result);
  }
);

export default router;
