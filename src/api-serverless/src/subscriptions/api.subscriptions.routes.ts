import { Request, Response } from 'express';
import * as Joi from 'joi';
import { fetchEns } from '../../../db-api';
import { fetchAirdropAddressForConsolidationKey } from '../../../delegationsLoop/db.delegations';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorisedException
} from '../../../exceptions';
import { getNft } from '../../../nftsLoop/db.nfts';
import { numbers } from '../../../numbers';
import { evictAllKeysMatchingPatternFromRedisCache } from '../../../redis';
import { equalIgnoreCase } from '../../../strings';
import { PaginatedResponse } from '../api-constants';
import {
  getCacheKeyPatternForPath,
  getPage,
  getPageSize,
  giveReadReplicaTimeToCatchUp
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { populateDistribution } from '../distributions/api.distributions.service';
import { NFTFinalSubscription } from '../generated/models/NFTFinalSubscription';
import { NFTSubscription } from '../generated/models/NFTSubscription';
import { PhaseAirdrop } from '../generated/models/PhaseAirdrop';
import { RedeemedSubscription } from '../generated/models/RedeemedSubscription';
import { RedeemedSubscriptionCounts } from '../generated/models/RedeemedSubscriptionCounts';
import { SubscriptionCounts } from '../generated/models/SubscriptionCounts';
import { SubscriptionDetails } from '../generated/models/SubscriptionDetails';
import { SubscriptionTopUp } from '../generated/models/SubscriptionTopUp';
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
  fetchFinalSubscriptionsByPhase,
  fetchLogsForConsolidationKey,
  fetchPastMemeSubscriptionCounts,
  fetchRedeemedSubscriptionsForConsolidationKey,
  fetchSubscriptionUploads,
  fetchTopUpsForConsolidationKey,
  fetchUpcomingMemeSubscriptionCounts,
  fetchUpcomingMemeSubscriptions,
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

async function invalidateMemesMintingPhaseCache(
  contract: string,
  tokenId: number
) {
  await evictCacheForPath(`/api/memes-minting/roots/${contract}/${tokenId}`);
  await evictCacheForPath(`/api/memes-minting/proofs/`);
  await evictCacheForPath(`/api/distributions/${contract}/${tokenId}/overview`);
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

function normalizeFinalSubscriptionPhaseName(phaseName: string): string {
  const trimmedPhaseName = phaseName.trim();
  const compactPhaseName = trimmedPhaseName.toLowerCase().replace(/\s+/g, '');

  switch (compactPhaseName) {
    case 'phase0':
      return 'Phase 0';
    case 'phase1':
      return 'Phase 1';
    case 'phase2':
      return 'Phase 2';
    case 'public':
    case 'publicphase':
      return 'Public';
    default:
      return trimmedPhaseName;
  }
}

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
  `/final/:contract/:token_id/phases/:phase_name`,
  async function (
    req: Request<
      {
        contract: string;
        token_id: string;
        phase_name: string;
      },
      any,
      any,
      any
    >,
    res: Response<PhaseAirdrop[] | string>
  ) {
    const contract = req.params.contract;
    const tokenId = numbers.parseIntOrNull(req.params.token_id);
    if (tokenId === null) {
      return res.status(400).send('Invalid token ID');
    }

    const phaseName = normalizeFinalSubscriptionPhaseName(
      req.params.phase_name
    );
    const results = await fetchFinalSubscriptionsByPhase(
      contract,
      tokenId,
      phaseName
    );
    return res.json(results);
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
      await invalidateMemesMintingPhaseCache(contract, tokenId);
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
    await invalidateMemesMintingPhaseCache(contract, tokenId);

    return res.json({
      success: true,
      statusText: 'Reset successful'
    });
  }
);
