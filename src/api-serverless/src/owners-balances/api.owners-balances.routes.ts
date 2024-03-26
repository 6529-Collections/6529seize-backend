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

    fetchOwnerBalancesForConsolidationKey(consolidationKey).then((result) => {
      if (result) {
        return returnJsonResult(result, req, res);
      }
      throw new NotFoundException(
        `Consolidation Owner Balance for ${consolidationKey} not found`
      );
    });
  }
);

router.get(
  '/consolidation/:consolidation_key/memes',
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

    fetchMemesOwnerBalancesForConsolidationKey(consolidationKey).then(
      (result) => {
        if (result) {
          return returnJsonResult(result, req, res);
        }
        throw new NotFoundException(
          `Consolidation Memes Owner Balance for ${consolidationKey} not found`
        );
      }
    );
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
    fetchOwnerBalancesForWallet(wallet).then((result) => {
      if (result) {
        return returnJsonResult(result, req, res);
      }
      throw new NotFoundException(
        `Wallet Owner Balance for ${wallet} not found`
      );
    });
  }
);

router.get(
  '/wallet/:consolidation_key/memes',
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

    fetchMemesOwnerBalancesForWallet(consolidationKey).then((result) => {
      if (result) {
        return returnJsonResult(result, req, res);
      }
      throw new NotFoundException(
        `Wallet Memes Owner Balance for ${consolidationKey} not found`
      );
    });
  }
);
