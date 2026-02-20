import { Request, Response } from 'express';
import * as Joi from 'joi';
import { fetchEns } from '@/db-api';
import { fetchAirdropAddressForConsolidationKey } from '@/delegationsLoop/db.delegations';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorisedException
} from '@/exceptions';
import { getNft } from '@/nftsLoop/db.nfts';
import { numbers } from '@/numbers';
import { evictAllKeysMatchingPatternFromRedisCache } from '@/redis';
import { equalIgnoreCase } from '@/strings';
import { PaginatedResponse } from '@/api/api-constants';
import {
  getCacheKeyPatternForPath,
  getPage,
  getPageSize,
  giveReadReplicaTimeToCatchUp
} from '@/api/api-helpers';
import { asyncRouter } from '@/api/async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '@/api/auth/auth';
import { populateDistribution } from '@/api/distributions/api.distributions.service';
import { NFTFinalSubscription } from '@/api/generated/models/NFTFinalSubscription';
import { NFTSubscription } from '@/api/generated/models/NFTSubscription';
import { ApiUpcomingMemeSubscriptionStatus } from '@/api/generated/models/ApiUpcomingMemeSubscriptionStatus';
import { RedeemedSubscription } from '@/api/generated/models/RedeemedSubscription';
import { RedeemedSubscriptionCounts } from '@/api/generated/models/RedeemedSubscriptionCounts';
import { SubscriptionCounts } from '@/api/generated/models/SubscriptionCounts';
import { SubscriptionDetails } from '@/api/generated/models/SubscriptionDetails';
import { SubscriptionTopUp } from '@/api/generated/models/SubscriptionTopUp';
import { cacheRequest } from '@/api/request-cache';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  authenticateSubscriptionsAdmin,
  fetchPhaseName,
  fetchPhaseResults,
  getPublicSubscriptions,
  resetAllowlist,
  splitAllowlistResults,
  validateDistribution
} from '@/api/subscriptions/api.subscriptions.allowlist';
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
  fetchUpcomingMemeSubscriptionStatusForConsolidationKey,
  fetchUpcomingMemeSubscriptions,
  updateSubscribeAllEditions,
  updateSubscription,
  updateSubscriptionCount,
  updateSubscriptionMode
} from '@/api/subscriptions/api.subscriptions.db';

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
    res: Response<SubscriptionDetails | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();

    const result = await fetchDetailsForConsolidationKey(consolidationKey);
    if (result) {
      return res.json(result);
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
    res: Response<PaginatedResponse<SubscriptionTopUp> | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const pageSize = getPageSize(req, 20);
    const page = getPage(req);

    const result = await fetchTopUpsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return res.json(result);
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
    res: Response<NFTSubscription[] | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const cardCount = numbers.parseIntOrNull(req.query.card_count) ?? 3;

    const result = await fetchUpcomingMemeSubscriptions(
      consolidationKey,
      cardCount
    );
    return res.json(result);
  }
);

router.get(
  `/consolidation/upcoming-memes/:meme_id/:consolidation_key`,
  async function (
    req: Request<
      {
        meme_id: string;
        consolidation_key: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiUpcomingMemeSubscriptionStatus | string>
  ) {
    const memeId = numbers.parseIntOrNull(req.params.meme_id);
    if (memeId === null || memeId < 1) {
      return res.status(400).send('Invalid meme ID');
    }

    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const result = await fetchUpcomingMemeSubscriptionStatusForConsolidationKey(
      consolidationKey,
      memeId
    );
    return res.json(result);
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
    const cardCount = numbers.parseIntOrNull(req.query.card_count) ?? 3;

    const result = await fetchUpcomingMemeSubscriptionCounts(cardCount);
    return res.json(result);
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
    res: Response<PaginatedResponse<RedeemedSubscriptionCounts>>
  ) {
    const pageSize = getPageSize(req, 20);
    const page = getPage(req);

    const result = await fetchPastMemeSubscriptionCounts(pageSize, page);
    return res.json(result);
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
    res: Response<PaginatedResponse<SubscriptionTopUp> | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const pageSize = getPageSize(req, 20);
    const page = getPage(req);

    const result = await fetchLogsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return res.json(result);
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
    res: Response<PaginatedResponse<RedeemedSubscription> | string>
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const pageSize = getPageSize(req, 20);
    const page = getPage(req);

    const result = await fetchRedeemedSubscriptionsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return res.json(result);
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
    res: Response<
      | {
          tdh_wallet: { address: string; ens: string };
          airdrop_address: { address: string; ens: string };
        }
      | string
    >
  ) {
    const consolidationKey = req.params.consolidation_key.toLowerCase();
    const result =
      await fetchAirdropAddressForConsolidationKey(consolidationKey);
    const ensTdhWallet = await fetchEns(result.tdh_wallet);
    const ensAirdrop = await fetchEns(result.airdrop_address);
    return res.json({
      tdh_wallet: {
        address: result.tdh_wallet,
        ens: ensTdhWallet[0]?.display ?? ''
      },
      airdrop_address: {
        address: result.airdrop_address,
        ens: ensAirdrop[0]?.display ?? ''
      }
    });
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
    const tokenId = numbers.parseIntOrNull(req.params.token_id);
    if (tokenId === null) {
      return res.status(400).send('Invalid token ID');
    }

    const result = await fetchFinalSubscription(
      consolidationKey,
      contract,
      tokenId
    );
    if (result) {
      return res.json(result);
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
    res: Response<PaginatedResponse<SubscriptionTopUp> | string>
  ) {
    const contract = req.query.contract;
    if (!contract) {
      throw new BadRequestException('Contract is required');
    }
    const pageSize = getPageSize(req, 20);
    const page = getPage(req);

    const result = await fetchSubscriptionUploads(contract, pageSize, page);
    return res.json(result);
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

    const tokenId = numbers.parseIntOrNull(tokenIdStr);
    if (tokenId === null) {
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
      return res.json(results);
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
      return res.json(results);
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

    const tokenId = numbers.parseIntOrNull(tokenIdStr);
    if (tokenId === null) {
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

    return res.json({
      success: true,
      statusText: 'Reset successful'
    });
  }
);
