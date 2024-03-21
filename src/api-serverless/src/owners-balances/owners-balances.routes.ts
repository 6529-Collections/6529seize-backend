import { Request } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';

import { returnJsonResult } from '../api-helpers';
import {
  fetchMemesOwnerBalancesForConsolidationKey,
  fetchMemesOwnerBalancesForWallet,
  fetchOwnerBalancesForConsolidationKey,
  fetchOwnerBalancesForWallet
} from './owners-balances.db';

const router = asyncRouter();

const logger = Logger.get('OWNERS_BALANCES_API');

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
      } else {
        return res.status(404).send({});
      }
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
        } else {
          return res.status(404).send({});
        }
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
      } else {
        return res.status(404).send({});
      }
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
      } else {
        return res.status(404).send({});
      }
    });
  }
);
