import { Request, Response } from 'express';
import * as Joi from 'joi';
import { NotFoundException } from '@/exceptions';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { asyncRouter } from '@/api/async.router';
import { ApiResponse } from '@/api/api-response';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '@/api/page-request';
import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { cacheRequest } from '@/api/request-cache';
import { resolveSortDirection, returnPaginatedResult } from '@/api/api-helpers';
import { ApiMemesMintStat } from '@/api/generated/models/ApiMemesMintStat';
import { ApiMemesMintStatsPage } from '@/api/generated/models/ApiMemesMintStatsPage';
import { ApiMemesMintStatsTotals } from '@/api/generated/models/ApiMemesMintStatsTotals';
import { ApiMemesMintStatsYearly } from '@/api/generated/models/ApiMemesMintStatsYearly';
import {
  fetchMemesMintStatById,
  fetchMemesMintStats,
  fetchMemesMintStatsTotals,
  fetchMemesMintStatsYearly
} from '@/api/memes-mint-stats/api.memes-mint-stats.db';

const router = asyncRouter();

const ListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number()
    .integer()
    .min(1)
    .max(DEFAULT_MAX_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  sort_direction: Joi.string()
    .valid(...Object.values(ApiPageSortDirection))
    .default(ApiPageSortDirection.Asc)
});

const IdParamsSchema = Joi.object({
  id: Joi.number().integer().min(1).required()
});

router.get(
  '/',
  cacheRequest(),
  async (
    req: Request<
      any,
      any,
      any,
      { page: number; page_size: number; sort_direction: ApiPageSortDirection }
    >,
    res: Response<ApiResponse<ApiMemesMintStatsPage>>
  ) => {
    const query = getValidatedByJoiOrThrow(req.query, ListQuerySchema);
    const result = await fetchMemesMintStats(
      query.page,
      query.page_size,
      resolveSortDirection(query.sort_direction)
    );
    return returnPaginatedResult(result, req, res);
  }
);

router.get(
  '/total',
  cacheRequest(),
  async (
    _req: Request,
    res: Response<ApiResponse<ApiMemesMintStatsTotals>>
  ) => {
    const result = await fetchMemesMintStatsTotals();
    return res.json(result);
  }
);

router.get(
  '/yearly',
  cacheRequest(),
  async (
    _req: Request,
    res: Response<ApiResponse<ApiMemesMintStatsYearly[]>>
  ) => {
    const result = await fetchMemesMintStatsYearly();
    return res.json(result);
  }
);

router.get(
  '/:id',
  cacheRequest(),
  async (
    req: Request<{ id: number }>,
    res: Response<ApiResponse<ApiMemesMintStat>>
  ) => {
    const { id } = getValidatedByJoiOrThrow(req.params, IdParamsSchema);
    const result = await fetchMemesMintStatById(id);

    if (!result) {
      throw new NotFoundException(`Memes mint stats for id ${id} not found`);
    }

    return res.json(result);
  }
);

export default router;
