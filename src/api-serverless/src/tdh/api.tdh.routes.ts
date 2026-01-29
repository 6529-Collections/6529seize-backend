import { Request, Response } from 'express';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  WALLETS_TDH_TABLE
} from '../../../constants';
import { enums } from '../../../enums';
import { NotFoundException } from '../../../exceptions';
import { parseTdhDataFromDB } from '../../../sql_helpers';
import { Timer } from '../../../time';
import { NFT_TDH_SORT } from '../api-filters';
import {
  resolveSortDirection,
  returnCSVResult,
  returnPaginatedResult
} from '../api-helpers';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { ApiConsolidatedTdh } from '../generated/models/ApiConsolidatedTdh';
import { identityFetcher } from '../identities/identity.fetcher';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { cacheRequest } from '../request-cache';
import {
  fetchConsolidatedMetrics,
  fetchNftTdh,
  fetchTDH,
  MetricsCollector,
  MetricsContent
} from './api.tdh.db';

const router = asyncRouter();

export default router;

export const METRICS_SORT = [
  'level',
  'balance',
  'unique_memes',
  'memes_cards_sets',
  'boosted_tdh',
  'day_change'
];

router.get(
  `/nft/:contract/:nft_id`,
  cacheRequest(),
  async function (
    req: Request<
      {
        contract: string;
        nft_id: number;
      },
      any,
      any,
      {
        sort?: string;
        sort_direction: any;
        page?: number;
        page_size?: number;
        search?: string;
      }
    >,
    res: any
  ) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;
    const page = req.query.page ?? 1;
    const pageSize = req.query.page_size ?? DEFAULT_PAGE_SIZE;
    const sort =
      req.query.sort && NFT_TDH_SORT.includes(req.query.sort.toLowerCase())
        ? req.query.sort
        : NFT_TDH_SORT[0];
    const sortDir = resolveSortDirection(req.query.sort_direction);
    const search = req.query.search;

    await fetchNftTdh(
      contract,
      nftId,
      sort,
      sortDir,
      page,
      pageSize,
      search
    ).then((result) => {
      return returnPaginatedResult(result, req, res);
    });
  }
);

router.get(
  `/consolidated_metrics`,
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
      req.query.sort && METRICS_SORT.includes(req.query.sort.toLowerCase())
        ? req.query.sort
        : METRICS_SORT[0];
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

    await fetchConsolidatedMetrics(sort, sortDir, page, pageSize, {
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
  '/consolidation/:identity',
  cacheRequest(),
  async function (
    req: Request<{ identity: string }, any, any, any>,
    res: Response<ApiResponse<ApiConsolidatedTdh>>
  ) {
    const identity = req.params.identity;
    const timer = Timer.getFromRequest(req);
    const consolidationKey = await identityFetcher
      .getIdentityAndConsolidationsByIdentityKey(
        { identityKey: identity },
        { timer }
      )
      .then((result) => result?.consolidation_key ?? identity);

    const result = await fetchTDH(
      'consolidation_key',
      consolidationKey,
      CONSOLIDATED_WALLETS_TDH_TABLE
    );
    if (result) {
      const parsedResult = parseTdhDataFromDB(result);
      return res.json(parsedResult);
    }
    throw new NotFoundException(`Consolidated TDH for ${identity} not found`);
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

    const result = await fetchTDH('wallet', wallet, WALLETS_TDH_TABLE);
    if (result) {
      const parsedResult = parseTdhDataFromDB(result);
      return res.json(parsedResult);
    }
    throw new NotFoundException(`Wallet TDH for ${wallet} not found`);
  }
);
