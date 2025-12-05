import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import * as Joi from 'joi';
import {
  XTdhCollectionsQueryParams,
  XTdhContributorsQueryParams,
  XTdhGranteesQueryParams,
  xTdhInfoService,
  XTdhTokensQueryParams
} from './xtdh-info.service';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { ApiXTdhCollectionsPage } from '../generated/models/ApiXTdhCollectionsPage';
import { ApiXTdhTokensPage } from '../generated/models/ApiXTdhTokensPage';
import { ApiXTdhContributionsPage } from '../generated/models/ApiXTdhContributionsPage';
import { ApiXTdhGranteesPage } from '../generated/models/ApiXTdhGranteesPage';
import { cacheRequest } from '../request-cache';
import xTdhGrantsRoutes from './grants/xtdh-grants.routes';
import xTdhStatsRoutes from './stats/xtdh-stats.routes';

const XTdhCollectionsQueryParamsSchema: Joi.ObjectSchema<XTdhCollectionsQueryParams> =
  Joi.object<XTdhCollectionsQueryParams>({
    identity: Joi.string().optional().default(null),
    collection_name: Joi.string().optional().default(null),
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(20),
    sort: Joi.string()
      .optional()
      .valid(...['xtdh', 'xtdh_rate'])
      .default('xtdh'),
    order: Joi.string()
      .optional()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc)
  });

const XTdhTokensQueryParamsSchema: Joi.ObjectSchema<XTdhTokensQueryParams> =
  Joi.object<XTdhTokensQueryParams>({
    identity: Joi.string().optional().default(null),
    contract: Joi.string().optional().default(null),
    token: Joi.number().optional().default(null),
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(20),
    sort: Joi.string()
      .optional()
      .valid(...['xtdh', 'xtdh_rate'])
      .default('xtdh'),
    order: Joi.string()
      .optional()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc)
  });

const XTdhContributorsQueryParamsSchema: Joi.ObjectSchema<XTdhContributorsQueryParams> =
  Joi.object<XTdhContributorsQueryParams>({
    contract: Joi.string().required(),
    token: Joi.number().required(),
    group_by: Joi.string()
      .optional()
      .valid(...['grant', 'grantor'])
      .default('grant'),
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(20),
    sort: Joi.string()
      .optional()
      .valid(...['xtdh', 'xtdh_rate'])
      .default('xtdh'),
    order: Joi.string()
      .optional()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc)
  });

const XTdhGranteesQueryParamsSchema: Joi.ObjectSchema<XTdhGranteesQueryParams> =
  Joi.object<XTdhGranteesQueryParams>({
    contract: Joi.string().optional().default(null),
    page: Joi.number().optional().integer().min(1).default(1),
    page_size: Joi.number().optional().integer().min(1).max(100).default(20),
    sort: Joi.string()
      .optional()
      .valid(...['xtdh', 'xtdh_rate'])
      .default('xtdh'),
    order: Joi.string()
      .optional()
      .valid(...Object.values(ApiPageSortDirection))
      .default(ApiPageSortDirection.Desc)
  });

const router = asyncRouter();

router.get(
  '/collections',
  cacheRequest(),
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, XTdhCollectionsQueryParams, any>,
    res: Response<ApiResponse<ApiXTdhCollectionsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const params = getValidatedByJoiOrThrow(
      req.query,
      XTdhCollectionsQueryParamsSchema
    );

    const resp = await xTdhInfoService.getXTdhCollections(params, ctx);

    res.send(resp);
  }
);

router.get(
  '/tokens',
  cacheRequest(),
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, XTdhTokensQueryParams, any>,
    res: Response<ApiResponse<ApiXTdhTokensPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const params = getValidatedByJoiOrThrow(
      req.query,
      XTdhTokensQueryParamsSchema
    );

    const results = await xTdhInfoService.getXTdhTokens(params, ctx);
    res.send(results);
  }
);

router.get(
  '/tokens/:contract/:token/contributors',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { contract: string; token: number },
      any,
      any,
      Omit<XTdhContributorsQueryParams, 'contract' | 'token'>,
      any
    >,
    res: Response<ApiResponse<ApiXTdhContributionsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const params = getValidatedByJoiOrThrow(
      { ...req.query, ...req.params },
      XTdhContributorsQueryParamsSchema
    );

    const results = await xTdhInfoService.getXTdhContributors(params, ctx);
    res.send(results);
  }
);

router.get(
  '/grantees',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, XTdhGranteesQueryParams, any>,
    res: Response<ApiResponse<ApiXTdhGranteesPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx: RequestContext = { timer, authenticationContext };
    const params = getValidatedByJoiOrThrow(
      { ...req.query, ...req.params },
      XTdhGranteesQueryParamsSchema
    );

    const results = await xTdhInfoService.getXTdhGrantees(params, ctx);
    res.send(results);
  }
);

router.use('/grants', xTdhGrantsRoutes);
router.use('/stats', xTdhStatsRoutes);

export default router;
