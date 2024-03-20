import { Request } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';

import { DEFAULT_PAGE_SIZE } from 'src/page-request';
import {
  resolveSortDirection,
  returnJsonResult,
  returnPaginatedResult
} from 'src/api-helpers';
import { MetricsContent, MetricsCollector } from 'src/tdh/tdh.db';
import { resolveEnum } from '../../../helpers';
import {
  fetchAggregatedActivity,
  fetchAggregatedActivityForKey
} from './aggregated-activity.db';

const router = asyncRouter();

const logger = Logger.get('AGGREGATED_ACTIVITY_API');

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
      {},
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
      }
    >,
    res: any
  ) {
    const page = req.query.page || 1;
    const pageSize = req.query.page_size || DEFAULT_PAGE_SIZE;
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

    fetchAggregatedActivity(
      sort,
      sortDir,
      page,
      pageSize,
      search,
      content,
      collector,
      season
    ).then((result) => returnPaginatedResult(result, req, res));
  }
);

router.get(
  '/:consolidation_key',
  function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const consolidationKey = req.params.consolidation_key;

    fetchAggregatedActivityForKey(consolidationKey).then((result) => {
      returnJsonResult(result, req, res);
    });
  }
);
