import { Request } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import {
  MetricsCollector,
  MetricsContent,
  fetchConsolidatedMetrics,
  fetchNftTdh,
  fetchSingleTDH
} from './tdh.db';
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

const router = asyncRouter();

const logger = Logger.get('TDH_API');

export default router;

export const NFT_TDH_SORT = [
  'balance',
  'boosted_tdh',
  'tdh__raw',
  'total_balance',
  'total_boosted_tdh',
  'total_tdh__raw'
];

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

    fetchConsolidatedMetrics(
      sort,
      sortDir,
      page,
      pageSize,
      search,
      content,
      collector,
      season
    ).then(async (result) => {
      logger.info(
        `[CONSOLIDATED_TDH] : [FETCHED ${result.count} TDH] : [SORT ${sort}] : [SORT_DIRECTION ${sortDir}] : [PAGE ${page}] : [PAGE_SIZE ${pageSize}] `
      );
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

    fetchSingleTDH(
      'consolidation_key',
      consolidationKey,
      CONSOLIDATED_WALLETS_TDH_TABLE
    ).then((result) => {
      if (result) {
        const parsedResult = parseTdhDataFromDB(result);
        return returnJsonResult(parsedResult, req, res);
      } else {
        return res.status(404).send({});
      }
    });
  }
);

router.get(
  '/wallet/:wallet',
  function (
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

    fetchSingleTDH('wallet', wallet, WALLETS_TDH_TABLE).then((result) => {
      if (result) {
        const parsedResult = parseTdhDataFromDB(result);
        return returnJsonResult(parsedResult, req, res);
      } else {
        return res.status(404).send({});
      }
    });
  }
);
