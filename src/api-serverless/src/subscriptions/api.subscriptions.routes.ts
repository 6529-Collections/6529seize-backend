import { Request, Response } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import { giveReadReplicaTimeToCatchUp, returnJsonResult } from '../api-helpers';
import {
  fetchDetailsForConsolidationKey,
  fetchConsolidationWallets,
  fetchTopUpsForConsolidationKey,
  updateSubscriptionMode
} from './api.subscriptions.db';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../../../entities/ISubscription.ts';
import { getWalletOrThrow, needsAuthenticatedUser } from 'src/auth/auth';
import { areEqualAddresses } from '../../../helpers';
import { ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from 'src/validation';
import * as Joi from 'joi';
const router = asyncRouter();

export default router;

router.get(
  `/consolidation-details/:consolidation_key`,
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
    const consolidationKey = req.params.consolidation_key.toLowerCase();

    fetchDetailsForConsolidationKey(consolidationKey).then((result) => {
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
    const consolidationKey = req.params.consolidation_key.toLowerCase();
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

router.post(
  `/:consolidation_key/subscription-mode`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      {
        automatic: boolean;
      },
      any,
      any
    >,
    res: Response
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();

    if (!isAuthenticatedForConsolidationKey(req, consolidationKey)) {
      throw new ForbiddenException(
        `User can only change subscription mode for their own consolidation`
      );
    }
    const requestPayload = getValidatedByJoiOrThrow(
      req.body,
      Joi.object({
        automatic: Joi.boolean().required()
      })
    );
    await updateSubscriptionMode(consolidationKey, requestPayload.automatic);
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send({ automatic: requestPayload.automatic });
  }
);

async function isAuthenticatedForConsolidationKey(
  req: Request,
  consolidationKey: string
) {
  const authenticatedWallet = getWalletOrThrow(req);
  const consolidationWallets = await fetchConsolidationWallets(
    consolidationKey
  );
  return consolidationWallets.some((wallet) =>
    areEqualAddresses(wallet, authenticatedWallet)
  );
}
