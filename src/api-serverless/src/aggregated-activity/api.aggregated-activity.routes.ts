import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';

import { enums } from '../../../enums';
import { NotFoundException } from '../../../exceptions';
import {
  resolveSortDirection,
  returnCSVResult,
  returnPaginatedResult
} from '../api-helpers';
import { ApiResponse } from '../api-response';
import { ApiAggregatedActivity } from '../generated/models/ApiAggregatedActivity';
import { ApiAggregatedActivityMemes } from '../generated/models/ApiAggregatedActivityMemes';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { cacheRequest } from '../request-cache';
import { MetricsCollector, MetricsContent } from '../tdh/api.tdh.db';
import {
  fetchAggregatedActivity,
  fetchAggregatedActivityForConsolidationKey,
  fetchAggregatedActivityForWallet,
  fetchMemesAggregatedActivityForConsolidationKey,
  fetchMemesAggregatedActivityForWallet
} from './api.aggregated-activity.db';

const router = asyncRouter();

export default router;

export const AGGREGATED_ACTIVITY_SORT = [
  'primary_purchases_count',
  'primary_purchases_value',
  'secondary_purchases_count',
  'secondary_purchases_value',
  'sales_count',
  'sales_value',
  'transfers_in',
  'transfers_out',
  'airdrops',
  'burns'
];

router.get(
  '/',
  cacheRequest(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        sort?: string;
        sort_direction: any;
        page?: number;
        page_size?: number;
        search?: string;
        content?: string;
        collector?: string;
        season?: number;
        download_page?: boolean;
        download_all?: boolean;
      }
    >,
    res: any
  ) {
    let page = req.query.page ?? 1;
    let pageSize = req.query.page_size ?? DEFAULT_PAGE_SIZE;
    const sort =
      req.query.sort &&
      AGGREGATED_ACTIVITY_SORT.includes(req.query.sort.toLowerCase())
        ? req.query.sort
        : AGGREGATED_ACTIVITY_SORT[0];
    const sortDir = resolveSortDirection(req.query.sort_direction);
    const search = req.query.search;
    const content = enums.resolve(MetricsContent, req.query.content);
    const season = req.query.season;
    const collector = enums.resolve(MetricsCollector, req.query.collector);

    const downloadPage = req.query.download_page;
    const downloadAll = req.query.download_all;
    if (downloadAll) {
      pageSize = Number.MAX_SAFE_INTEGER;
      page = 1;
    }

    await fetchAggregatedActivity(sort, sortDir, page, pageSize, {
      search,
      content,
      collector,
      season
    }).then((result) => {
      if (downloadAll || downloadPage) {
        return returnCSVResult('consolidated_metrics', result.data, res);
      } else {
        return returnPaginatedResult(result, req, res);
      }
    });
  }
);

router.get(
  '/consolidation/:consolidation_key',
  cacheRequest(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiAggregatedActivity>>
  ) {
    const consolidationKey = req.params.consolidation_key;

    const result =
      await fetchAggregatedActivityForConsolidationKey(consolidationKey);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Consolidated Aggregated activity for ${consolidationKey} not found`
    );
  }
);

router.get(
  '/consolidation/:consolidation_key/memes',
  cacheRequest(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiAggregatedActivityMemes[]>>
  ) {
    const consolidationKey = req.params.consolidation_key;
    const result =
      await fetchMemesAggregatedActivityForConsolidationKey(consolidationKey);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Consolidated Memes Aggregated activity for ${consolidationKey} not found`
    );
  }
);

router.get(
  '/wallet/:wallet',
  cacheRequest(),
  async function (
    req: Request<
      {
        wallet: string;
      },
      any,
      any,
      any
    >,
    res: any
  ) {
    const wallet = req.params.wallet;

    const result = await fetchAggregatedActivityForWallet(wallet);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Wallet Aggregated activity for ${wallet} not found`
    );
  }
);

router.get(
  '/wallet/:wallet/memes',
  cacheRequest(),
  async function (
    req: Request<
      {
        wallet: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiAggregatedActivityMemes[]>>
  ) {
    const wallet = req.params.wallet;

    const result = await fetchMemesAggregatedActivityForWallet(wallet);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Wallet Memes Aggregated activity for ${wallet} not found`
    );
  }
);
