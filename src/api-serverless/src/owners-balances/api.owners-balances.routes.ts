import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';

import { NotFoundException } from '../../../exceptions';
import { resolveSortDirection, returnPaginatedResult } from '../api-helpers';
import { ApiResponse } from '../api-response';
import { ApiOwnerBalance } from '../generated/models/ApiOwnerBalance';
import { ApiOwnerBalanceMemes } from '../generated/models/ApiOwnerBalanceMemes';
import { DEFAULT_PAGE_SIZE } from '../page-request';
import { cacheRequest } from '../request-cache';
import {
  fetchAllOwnerBalances,
  fetchMemesOwnerBalancesForConsolidationKey,
  fetchMemesOwnerBalancesForWallet,
  fetchOwnerBalancesForConsolidationKey,
  fetchOwnerBalancesForWallet
} from './api.owners-balances.db';

const router = asyncRouter();

export default router;

router.get(
  '/',
  cacheRequest(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        sort_direction: any;
        page?: number;
        page_size?: number;
      }
    >,
    res: any
  ) {
    const page = req.query.page ?? 1;
    const pageSize = req.query.page_size ?? DEFAULT_PAGE_SIZE;
    const sortDir = resolveSortDirection(req.query.sort_direction);
    const result = await fetchAllOwnerBalances(page, pageSize, sortDir);
    return returnPaginatedResult(result, req, res);
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
    res: Response<ApiResponse<ApiOwnerBalance>>
  ) {
    const consolidationKey = req.params.consolidation_key;

    const result =
      await fetchOwnerBalancesForConsolidationKey(consolidationKey);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Consolidation Owner Balance for ${consolidationKey} not found`
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
    res: Response<ApiResponse<ApiOwnerBalanceMemes[]>>
  ) {
    const consolidationKey = req.params.consolidation_key;
    const result =
      await fetchMemesOwnerBalancesForConsolidationKey(consolidationKey);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Consolidation Memes Owner Balance for ${consolidationKey} not found`
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
    const result = await fetchOwnerBalancesForWallet(wallet);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(`Wallet Owner Balance for ${wallet} not found`);
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
    res: Response<ApiResponse<ApiOwnerBalanceMemes[]>>
  ) {
    const wallet = req.params.wallet;

    const result = await fetchMemesOwnerBalancesForWallet(wallet);
    if (result) {
      return res.json(result);
    }
    throw new NotFoundException(
      `Wallet Memes Owner Balance for ${wallet} not found`
    );
  }
);
