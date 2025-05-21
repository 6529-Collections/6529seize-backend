import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';

import { DEFAULT_PAGE_SIZE } from '../page-request';
import {
  resolveSortDirection,
  returnCSVResult,
  returnJsonResult,
  returnPaginatedResult
} from '../api-helpers';
import { MetricsCollector, MetricsContent } from '../tdh/api.tdh.db';
import { resolveEnum } from '../../../helpers';
import {
  fetchAggregatedActivity,
  fetchAggregatedActivityForConsolidationKey,
  fetchAggregatedActivityForWallet,
  fetchMemesAggregatedActivityForConsolidationKey,
  fetchMemesAggregatedActivityForWallet
} from './api.aggregated-activity.db';
import { NotFoundException } from '../../../exceptions';
import { ApiResponse } from '../api-response';
import { ApiAggregatedActivityPage } from '../generated/models/ApiAggregatedActivityPage';
import { ApiAggregatedActivity } from '../generated/models/ApiAggregatedActivity';
import { ApiAggregatedActivityMemes } from '../generated/models/ApiAggregatedActivityMemes';

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
  function (
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
    res: Response<ApiResponse<ApiAggregatedActivityPage>>
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
    const content = resolveEnum(MetricsContent, req.query.content);
    const season = req.query.season;
    const collector = resolveEnum(MetricsCollector, req.query.collector);

    const downloadPage = req.query.download_page;
    const downloadAll = req.query.download_all;
    if (downloadAll) {
      pageSize = Number.MAX_SAFE_INTEGER;
      page = 1;
    }

    fetchAggregatedActivity(sort, sortDir, page, pageSize, {
      search,
      content,
      collector,
      season
    }).then(async (result) => {
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

    const result = await fetchAggregatedActivityForConsolidationKey(
      consolidationKey
    );
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Consolidated Aggregated activity for ${consolidationKey} not found`
    );
  }
);

router.get(
  '/consolidation/:consolidation_key/memes',
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiAggregatedActivityMemes>>
  ) {
    const consolidationKey = req.params.consolidation_key;
    const result = await fetchMemesAggregatedActivityForConsolidationKey(
      consolidationKey
    );
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Consolidated Memes Aggregated activity for ${consolidationKey} not found`
    );
  }
);

router.get(
  '/wallet/:wallet',
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
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Wallet Aggregated activity for ${wallet} not found`
    );
  }
);

router.get(
  '/wallet/:wallet/memes',
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

    const result = await fetchMemesAggregatedActivityForWallet(wallet);
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Wallet Memes Aggregated activity for ${wallet} not found`
    );
  }
);
