import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import { giveReadReplicaTimeToCatchUp, returnJsonResult } from '../api-helpers';
import {
  fetchDetailsForConsolidationKey,
  fetchConsolidationWallets,
  fetchTopUpsForConsolidationKey,
  updateSubscriptionMode,
  fetchUpcomingMemeSubscriptions,
  updateSubscription,
  fetchLogsForConsolidationKey
} from './api.subscriptions.db';
import {
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionTopUp
} from '../../../entities/ISubscription';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { areEqualAddresses } from '../../../helpers';
import { ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
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
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

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

    const isAuthenticated = await isAuthenticatedForConsolidationKey(
      req,
      consolidationKey
    );
    if (!isAuthenticated) {
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
    const response = await updateSubscriptionMode(
      consolidationKey,
      requestPayload.automatic
    );
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send(response);
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

router.get(
  `/consolidation-upcoming-memes/:consolidation_key`,
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

    fetchUpcomingMemeSubscriptions(consolidationKey).then((result) => {
      if (result) {
        return returnJsonResult(result, req, res);
      } else {
        return res.status(404).send('Not found');
      }
    });
  }
);

router.post(
  `/:consolidation_key/subscription`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      {
        contract: string;
        token_id: number;
        subscribed: boolean;
      },
      any,
      any
    >,
    res: Response
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const isAuthenticated = await isAuthenticatedForConsolidationKey(
      req,
      consolidationKey
    );
    if (!isAuthenticated) {
      throw new ForbiddenException(
        `User can only change subscription mode for their own consolidation`
      );
    }
    const requestPayload = getValidatedByJoiOrThrow(
      req.body,
      Joi.object({
        contract: Joi.string().required(),
        token_id: Joi.number().required(),
        subscribed: Joi.boolean().required()
      })
    );
    const response = await updateSubscription(
      consolidationKey,
      requestPayload.contract,
      requestPayload.token_id,
      requestPayload.subscribed
    );
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send(response);
  }
);

router.get(
  `/consolidation-logs/:consolidation_key`,
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
    res: Response<SubscriptionLog[] | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

    fetchLogsForConsolidationKey(consolidationKey, pageSize, page).then(
      (result) => {
        if (result) {
          return returnJsonResult(result, req, res, true);
        } else {
          return res.status(404).send('Not found');
        }
      }
    );
  }
);
