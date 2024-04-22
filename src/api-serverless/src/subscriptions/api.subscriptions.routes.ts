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
  fetchLogsForConsolidationKey,
  fetchRedeemedSubscriptionsForConsolidationKey,
  fetchSubscriptionUploads,
  fetchFinalSubscription
} from './api.subscriptions.db';
import {
  NFTFinalSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionTopUp
} from '../../../entities/ISubscription';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { areEqualAddresses } from '../../../helpers';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import {
  fetchPhaseName,
  fetchPhaseResults,
  splitAllowlistResults,
  validateDistribution
} from './api.subscriptions.allowlist';
import { getNft } from '../../../nftsLoop/db.nfts';
import { fetchAirdropAddressForConsolidationKey } from '../../../delegationsLoop/db.delegations';
import { fetchEns } from '../../../db-api';

const router = asyncRouter();

export default router;

router.get(
  `/consolidation/details/:consolidation_key`,
  async function (
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

    const result = await fetchDetailsForConsolidationKey(consolidationKey);
    if (result) {
      return returnJsonResult(result, req, res);
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/consolidation/top-up/:consolidation_key`,
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
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

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
  return (
    consolidationWallets.some((wallet) =>
      areEqualAddresses(wallet, authenticatedWallet)
    ) || areEqualAddresses(consolidationKey, authenticatedWallet)
  );
}

router.get(
  `/consolidation/upcoming-memes/:consolidation_key`,
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

    const result = await fetchUpcomingMemeSubscriptions(consolidationKey, true);
    if (result) {
      return returnJsonResult(result, req, res);
    } else {
      return res.status(404).send('Not found');
    }
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
    await giveReadReplicaTimeToCatchUp();
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
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

    const result = await fetchLogsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return returnJsonResult(result, req, res, true);
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
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

    const result = await fetchRedeemedSubscriptionsForConsolidationKey(
      consolidationKey,
      pageSize,
      page
    );
    if (result) {
      return returnJsonResult(result, req, res, true);
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
    const result = await fetchAirdropAddressForConsolidationKey(
      consolidationKey
    );
    const ensTdhWallet = await fetchEns(result.tdh_wallet);
    const ensAirdrop = await fetchEns(result.airdrop_address);
    return returnJsonResult(
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
    const tokenId = parseInt(req.params.token_id);

    const result = await fetchFinalSubscription(
      consolidationKey,
      contract,
      tokenId
    );
    if (result) {
      return returnJsonResult(result, req, res, true);
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
    const pageSize = parseInt(req.query.page_size ?? '20');
    const page = parseInt(req.query.page ?? '1');

    const result = await fetchSubscriptionUploads(contract, pageSize, page);
    return returnJsonResult(result, req, res, true);
  }
);

router.get(
  `/allowlists/:contract/:token_id/:allowlist_id/:phase_id`,
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

    const tokenId = parseInt(tokenIdStr);
    if (isNaN(tokenId)) {
      return res.status(400).send({
        valid: false,
        statusText: 'Invalid token ID'
      });
    }

    const validate = await validateDistribution(auth, allowlistId, phaseId);
    if (!validate.valid) {
      return res.status(400).send(validate);
    }

    const phaseResults = await fetchPhaseResults(auth, allowlistId, phaseId);
    const phaseName = await fetchPhaseName(auth, allowlistId, phaseId);
    const results = await splitAllowlistResults(
      contract,
      tokenId,
      phaseName,
      phaseResults
    );
    return returnJsonResult(results, req, res);
  }
);
