import { Request } from 'express';
import { asyncRouter } from '../async.router';

import { returnJsonResult } from '../api-helpers';
import {
  fetchMemesOwnerBalancesForConsolidationKey,
  fetchMemesOwnerBalancesForWallet,
  fetchOwnerBalancesForConsolidationKey,
  fetchOwnerBalancesForWallet
} from './api.owners-balances.db';
import { NotFoundException } from '../../../exceptions';

const router = asyncRouter();

export default router;

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

    const result = await fetchOwnerBalancesForConsolidationKey(
      consolidationKey
    );
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Consolidation Owner Balance for ${consolidationKey} not found`
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
      {}
    >,
    res: any
  ) {
    const consolidationKey = req.params.consolidation_key;

    const result = await fetchMemesOwnerBalancesForConsolidationKey(
      consolidationKey
    );
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Consolidation Memes Owner Balance for ${consolidationKey} not found`
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
    const result = await fetchOwnerBalancesForWallet(wallet);
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(`Wallet Owner Balance for ${wallet} not found`);
  }
);

router.get(
  '/wallet/:consolidation_key/memes',
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

    const result = await fetchMemesOwnerBalancesForWallet(consolidationKey);
    if (result) {
      return returnJsonResult(result, req, res);
    }
    throw new NotFoundException(
      `Wallet Memes Owner Balance for ${consolidationKey} not found`
    );
  }
);
