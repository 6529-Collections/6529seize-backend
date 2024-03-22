import { Request, Response } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import { returnJsonResult } from '../api-helpers';
import {
  fetchBalanceForConsolidationKey,
  fetchTopUpsForConsolidationKey
} from './subscriptions.db';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../../../entities/ISubscription.ts';
const router = asyncRouter();

const logger = Logger.get('SUBSCRIPTIONS_API');

export default router;

router.get(
  `/consolidation-balance/:consolidation_key`,
  function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      {}
    >,
    res: Response<SubscriptionBalance | string>
  ) {
    const consolidationKey = req.params.consolidation_key;

    fetchBalanceForConsolidationKey(consolidationKey).then((result) => {
      if (result) {
        return returnJsonResult(result, req, res);
      } else {
        return res.status(404).send('Not found');
      }
    });
  }
);

router.get(
  `/consolidation-top-up/:consolidation_key`,
  function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      {
        page_size?: string;
        page?: string;
      }
    >,
    res: Response<SubscriptionTopUp[] | string>
  ) {
    const consolidationKey = req.params.consolidation_key;
    const pageSize = parseInt(req.query.page_size || '20');
    const page = parseInt(req.query.page || '1');

    fetchTopUpsForConsolidationKey(consolidationKey, pageSize, page).then(
      (result) => {
        if (result) {
          return returnJsonResult(result, req, res);
        } else {
          return res.status(404).send('Not found');
        }
      }
    );
  }
);
