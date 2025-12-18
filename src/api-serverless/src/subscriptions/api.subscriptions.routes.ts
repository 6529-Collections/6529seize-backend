import { Request, Response } from 'express';
import * as Joi from 'joi';
import { fetchEns } from '../../../db-api';
import { fetchAirdropAddressForConsolidationKey } from '../../../delegationsLoop/db.delegations';
import {
  NFTFinalSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionTopUp
} from '../../../entities/ISubscription';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorisedException
} from '../../../exceptions';
import { getNft } from '../../../nftsLoop/db.nfts';
import { evictAllKeysMatchingPatternFromRedisCache } from '../../../redis';
import { equalIgnoreCase } from '../../../strings';
import { PaginatedResponse } from '../api-constants';
import {
  getCacheKeyPatternForPath,
  giveReadReplicaTimeToCatchUp,
  returnJsonResult
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { populateDistribution } from '../distributions/api.distributions.service';
import { cacheRequest } from '../request-cache';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  authenticateSubscriptionsAdmin,
  fetchPhaseName,
  fetchPhaseResults,
  getPublicSubscriptions,
  resetAllowlist,
  splitAllowlistResults,
  validateDistribution
} from './api.subscriptions.allowlist';
import {
  fetchConsolidationAddresses,
  fetchDetailsForConsolidationKey,
  fetchFinalSubscription,
  fetchLogsForConsolidationKey,
  fetchPastMemeSubscriptionCounts,
  fetchRedeemedSubscriptionsForConsolidationKey,
  fetchSubscriptionUploads,
  fetchTopUpsForConsolidationKey,
  fetchUpcomingMemeSubscriptionCounts,
  fetchUpcomingMemeSubscriptions,
  RedeemedSubscriptionCounts,
  SubscriptionCounts,
  updateSubscribeAllEditions,
  updateSubscription,
  updateSubscriptionCount,
  updateSubscriptionMode
} from './api.subscriptions.db';

async function evictCacheForPath(path: string) {
  await evictAllKeysMatchingPatternFromRedisCache(
    getCacheKeyPatternForPath(`${path}*`)
  );
}

async function invalidateSubscriptionCache(consolidationKey: string) {
  await evictCacheForPath(
    `/api/subscriptions/consolidation/details/${consolidationKey}`
  );
  await evictCacheForPath(
    `/api/subscriptions/consolidation/upcoming-memes/${consolidationKey}`
  );
  await evictCacheForPath(`/api/subscriptions/upcoming-memes-counts`);
  await giveReadReplicaTimeToCatchUp();
}

const router = asyncRouter();

export default router;

router.get(
  `/consolidation/details/:consolidation_key`,
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
    res: Response<SubscriptionBalance | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();

    const result = await fetchDetailsForConsolidationKey(consolidationKey);
    if (result) {
      return await returnJsonResult(result, req, res);
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/consolidation/top-up/:consolidation_key`,
  cacheRequest(),
  async function (
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
    const pageSize = Number.parseInt(req.query.page_size ?? '20');
    const page = Number.parseInt(req.query.page ?? '1');

    const result = await fetchTopUpsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return returnJsonResult(result, req, res);
    } else {
      return res.status(404).send('Not found');
    }
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
    await invalidateSubscriptionCache(consolidationKey);
    res.status(201).send(response);
  }
);

router.post(
  `/:consolidation_key/subscribe-all-editions`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      {
        subscribe_all_editions: boolean;
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
        subscribe_all_editions: Joi.boolean().required()
      })
    );
    const response = await updateSubscribeAllEditions(
      consolidationKey,
      requestPayload.subscribe_all_editions
    );
    await invalidateSubscriptionCache(consolidationKey);
    res.status(201).send(response);
  }
);

async function isAuthenticatedForConsolidationKey(
  req: Request,
  consolidationKey: string
) {
  const authenticatedWallet = getWalletOrThrow(req);
  const consolidationWallets =
    await fetchConsolidationAddresses(consolidationKey);
  return (
    consolidationWallets.some((wallet) =>
      equalIgnoreCase(wallet, authenticatedWallet)
    ) || equalIgnoreCase(consolidationKey, authenticatedWallet)
  );
}

router.get(
  `/consolidation/upcoming-memes/:consolidation_key`,
  cacheRequest(),
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      {
        card_count?: string;
      }
    >,
    res: Response<SubscriptionTopUp[] | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const cardCount = Number.parseInt(req.query.card_count ?? '3');

    const result = await fetchUpcomingMemeSubscriptions(
      consolidationKey,
      cardCount
    );
    return await returnJsonResult(result, req, res);
  }
);

router.get(
  `/upcoming-memes-counts`,
  cacheRequest(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        card_count?: string;
      }
    >,
    res: Response<SubscriptionCounts[]>
  ) {
    const cardCount = Number.parseInt(req.query.card_count ?? '3');

    const result = await fetchUpcomingMemeSubscriptionCounts(cardCount);
    return await returnJsonResult(result, req, res);
  }
);

router.get(
  `/redeemed-memes-counts`,
  async function (
    req: Request<
      any,
      any,
      any,
      {
        page_size?: string;
        page?: string;
      }
    >,
    res: Response<
      | RedeemedSubscriptionCounts[]
      | PaginatedResponse<RedeemedSubscriptionCounts>
    >
  ) {
    const pageSize = req.query.page_size;
    const page = req.query.page;

    const result = await fetchPastMemeSubscriptionCounts(pageSize, page);
    return await returnJsonResult(result, req, res);
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
    const nft = await getNft(requestPayload.contract, requestPayload.token_id);
    if (nft) {
      throw new BadRequestException('NFT already released');
    }
    const response = await updateSubscription(
      consolidationKey,
      requestPayload.contract,
      requestPayload.token_id,
      requestPayload.subscribed
    );
    await invalidateSubscriptionCache(consolidationKey);
    res.status(201).send(response);
  }
);

router.post(
  `/:consolidation_key/subscription-count`,
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
        count: number;
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
        count: Joi.number().required()
      })
    );
    const nft = await getNft(requestPayload.contract, requestPayload.token_id);
    if (nft) {
      throw new BadRequestException('NFT already released');
    }
    const response = await updateSubscriptionCount(
      consolidationKey,
      requestPayload.contract,
      requestPayload.token_id,
      requestPayload.count
    );
    await invalidateSubscriptionCache(consolidationKey);
    res.status(201).send(response);
  }
);

router.get(
  `/consolidation/logs/:consolidation_key`,
  async function (
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
    const pageSize = Number.parseInt(req.query.page_size ?? '20');
    const page = Number.parseInt(req.query.page ?? '1');

    const result = await fetchLogsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return await returnJsonResult(result, req, res, true);
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/consolidation/redeemed/:consolidation_key`,
  async function (
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
    const pageSize = Number.parseInt(req.query.page_size ?? '20');
    const page = Number.parseInt(req.query.page ?? '1');

    const result = await fetchRedeemedSubscriptionsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return await returnJsonResult(result, req, res, true);
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/consolidation/:consolidation_key/airdrop-address`,
  async function (
    req: Request<
      {
        consolidation_key: string;
      },
      any,
      any,
      any
    >,
    res: Response<{ address: string; ens: string }>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const result =
      await fetchAirdropAddressForConsolidationKey(consolidationKey);
    const ensTdhWallet = await fetchEns(result.tdh_wallet);
    const ensAirdrop = await fetchEns(result.airdrop_address);
    return await returnJsonResult(
      {
        tdh_wallet: {
          address: result.tdh_wallet,
          ens: ensTdhWallet[0]?.display ?? ''
        },
        airdrop_address: {
          address: result.airdrop_address,
          ens: ensAirdrop[0]?.display ?? ''
        }
      },
      req,
      res,
      true
    );
  }
);

router.get(
  `/consolidation/final/:consolidation_key/:contract/:token_id`,
  async function (
    req: Request<
      {
        consolidation_key: string;
        contract: string;
        token_id: string;
      },
      any,
      any,
      any
    >,
    res: Response<NFTFinalSubscription | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const contract = req.params.contract;
    const tokenId = Number.parseInt(req.params.token_id);

    const result = await fetchFinalSubscription(
      consolidationKey,
      contract,
      tokenId
    );
    if (result) {
      return await returnJsonResult(result, req, res, true);
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/uploads`,
  async function (
    req: Request<
      any,
      any,
      any,
      {
        contract?: string;
        page_size?: string;
        page?: string;
      }
    >,
    res: Response<SubscriptionLog[] | string>
  ) {
    const contract = req.query.contract;
    if (!contract) {
      throw new BadRequestException('Contract is required');
    }
    const pageSize = Number.parseInt(req.query.page_size ?? '20');
    const page = Number.parseInt(req.query.page ?? '1');

    const result = await fetchSubscriptionUploads(contract, pageSize, page);
    return await returnJsonResult(result, req, res, true);
  }
);

router.get(
  `/allowlists/:contract/:token_id/:allowlist_id/:phase_id`,
  needsAuthenticatedUser(),
  cacheRequest(),
  async function (
    req: Request<
      {
        contract: string;
        token_id: string;
        allowlist_id: string;
        phase_id: string;
      },
      any,
      any,
      any
    >,
    res: Response<any>
  ) {
    const auth = req.headers.authorization ?? '';
    const contract = req.params.contract;
    const tokenIdStr = req.params.token_id;
    const allowlistId = req.params.allowlist_id;
    const phaseId = req.params.phase_id;

    const tokenId = Number.parseInt(tokenIdStr);
    if (Number.isNaN(tokenId)) {
      return res.status(400).send({
        valid: false,
        statusText: 'Invalid token ID'
      });
    }

    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can download allowlists'
      );
    }

    const validate = await validateDistribution(auth, allowlistId, phaseId);
    if (!validate.valid) {
      return res.status(400).send(validate);
    }

    if (phaseId === 'public') {
      const results = await getPublicSubscriptions(contract, tokenId);
      return await returnJsonResult(results, req, res);
    } else {
      const phaseResults = await fetchPhaseResults(auth, allowlistId, phaseId);
      const phaseName = await fetchPhaseName(auth, allowlistId, phaseId);

      const results = await splitAllowlistResults(
        contract,
        tokenId,
        phaseName,
        phaseResults
      );

      await populateDistribution(contract, tokenId, phaseName, results);
      return await returnJsonResult(results, req, res);
    }
  }
);

router.post(
  `/allowlists/:contract/:token_id/:allowlist_id/reset`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        contract: string;
        token_id: string;
        allowlist_id: string;
      },
      any,
      any,
      any
    >,
    res: Response<any>
  ) {
    const auth = req.headers.authorization ?? '';
    const contract = req.params.contract;
    const tokenIdStr = req.params.token_id;
    const allowlistId = req.params.allowlist_id;

    const tokenId = Number.parseInt(tokenIdStr);
    if (Number.isNaN(tokenId)) {
      return res.status(400).send({
        valid: false,
        statusText: 'Invalid token ID'
      });
    }

    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can reset allowlists'
      );
    }

    const validate = await validateDistribution(auth, allowlistId);
    if (!validate.valid) {
      return res.status(400).send(validate);
    }

    await resetAllowlist(contract, tokenId);

    await evictCacheForPath(
      `/api/distributions/${contract}/${tokenId}/overview`
    );

    return await returnJsonResult(
      {
        success: true,
        statusText: 'Reset successful'
      },
      req,
      res
    );
  }
);
