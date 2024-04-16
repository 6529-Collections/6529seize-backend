import { Request } from 'express';
import { asyncRouter } from '../async.router';
import {
  MetricsCollector,
  MetricsContent,
  fetchConsolidatedMetrics,
  fetchNftTdh,
  fetchSingleWalletTDH,
  fetchTDH
} from './api.tdh.db';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import {
  resolveSortDirection,
  returnCSVResult,
  returnJsonResult,
  returnPaginatedResult
} from '../api-helpers';
import { resolveEnum } from '../../../helpers';
import { parseTdhDataFromDB } from '../../../sql_helpers';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  WALLETS_TDH_TABLE
} from '../../../constants';
import { NotFoundException } from '../../../exceptions';
import { NFT_TDH_SORT } from '../api-filters';

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
  function (
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

    fetchNftTdh(contract, nftId, sort, sortDir, page, pageSize, search).then(
      (result) => returnPaginatedResult(result, req, res)
    );
  }
);

router.get(
  `/consolidated_metrics`,
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
    const content = resolveEnum(MetricsContent, req.query.content);
    const season = req.query.season;
    const collector = resolveEnum(MetricsCollector, req.query.collector);

    const downloadPage = req.query.download_page;
    const downloadAll = req.query.download_all;
    if (downloadAll) {
      pageSize = Number.MAX_SAFE_INTEGER;
      page = 1;
    }

    fetchConsolidatedMetrics(sort, sortDir, page, pageSize, {
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
      {}
    >,
    res: any
  ) {
    const consolidationKey = req.params.consolidation_key;

    const result = await fetchTDH(
      'consolidation_key',
      consolidationKey,
      CONSOLIDATED_WALLETS_TDH_TABLE
    );
    if (result) {
      const parsedResult = parseTdhDataFromDB(result);
      return returnJsonResult(parsedResult, req, res);
    }
    throw new NotFoundException(
      `Consolidated TDH for ${consolidationKey} not found`
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
      {}
    >,
    res: any
  ) {
    const wallet = req.params.wallet;

    const result = await fetchTDH('wallet', wallet, WALLETS_TDH_TABLE);
    if (result) {
      const parsedResult = parseTdhDataFromDB(result);
      return returnJsonResult(parsedResult, req, res);
    }
    throw new NotFoundException(`Wallet TDH for ${wallet} not found`);
  }
);

// used for chainlink
router.get(
  '/:wallet',
  async function (
    req: Request<
      {
        wallet: string;
      },
      any,
      any,
      {}
    >,
    res: any
  ) {
    const wallet = req.params.wallet;
    const result = await fetchSingleWalletTDH(wallet);
    return returnJsonResult(result, req, res);
  }
);
